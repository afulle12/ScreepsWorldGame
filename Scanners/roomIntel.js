/**
 * Room Intelligence Module  (v6.16 – event-attributed per-source extraction)
 * ===============================================================
 * Console:  intel('W1N1')       — full report (requires 100-tick profile)
 *           intelFast('W1N1')   — instant report (Economic/Military/Dual only)
 *           listIntel()
 *
 * Capture scoring (v6.16):
 *   Per-source fraction = sourceHarvested / (ticksObserved × maxRate),
 *   capped at 100%. Source-attributed energy comes from EV_HARVEST events
 *   so PWR_REGEN_SOURCE refilling the source mid-tick no longer hides the
 *   harvest. Final capture = average fraction × 25.
 *
 *   Per-source max rate accounts for:
 *     • Capacity   — owned/reserved 3000/300 = 10 E/t,
 *                    unreserved     1500/300 =  5 E/t,
 *                    SK rooms       4000/300 ≈ 13.33 E/t
 *     • PWR_REGEN_SOURCE effect — level 1-5 adds 50/100/150/200/250
 *       per 15-tick period (≈ +3.3..+16.7 E/t on top of base).
 *
 * Income display (v6.16):
 *   Income = sum of per-source harvested totals / ticksObserved, capped at
 *   sum of per-source max rates. Income and per-source fractions share the
 *   same numerator/denominator, so they're always consistent (the v6.15
 *   case where income was 36.8/46.7 yet capture showed 100% can't recur).
 */

'use strict';

const W = { economic:0.20, military:0.25, dualPurpose:0.30, operational:0.25 };
const W_FAST = { economic:0.20/0.75, military:0.25/0.75, dualPurpose:0.30/0.75 };

const PROFILE_TICKS  = 100;
const OBSERVER_RANGE = 10;
const EFF_EXPIRE     = 5000;
const EFF_MEM_KEY    = 'roomEffProfile';
const EFF_CACHE_KEY  = 'roomEffCache';
const EFF_GLOBAL_PREV = '__effPrev';

const EXTENSIONS_BY_RCL = {0:0,1:0,2:5,3:10,4:20,5:30,6:40,7:50,8:60};
const SPAWNS_BY_RCL     = {0:0,1:1,2:1,3:1,4:1,5:1,6:1,7:2,8:3};

const BODYPART_COST_MAP = {
    move:50,work:100,carry:50,attack:80,
    ranged_attack:150,heal:250,claim:600,tough:10
};

const COMBAT_BOOSTS = ['UH','UH2O','XUH2O','KO','KHO2','XKHO2','LO','LHO2','XLHO2'];

const STRUCT_COST = {
    [STRUCTURE_SPAWN]:15000,[STRUCTURE_EXTENSION]:3000,[STRUCTURE_ROAD]:300,
    [STRUCTURE_LINK]:5000,[STRUCTURE_STORAGE]:30000,[STRUCTURE_TOWER]:5000,
    [STRUCTURE_OBSERVER]:8000,[STRUCTURE_POWER_SPAWN]:100000,[STRUCTURE_EXTRACTOR]:5000,
    [STRUCTURE_LAB]:50000,[STRUCTURE_TERMINAL]:100000,[STRUCTURE_CONTAINER]:5000,
    [STRUCTURE_NUKER]:100000,[STRUCTURE_FACTORY]:100000,
};

const CREEP_REPAIR_HITS   = 100;
const TOWER_ENERGY_COST   = 10;
const TOWER_MAX_REPAIR    = 800;
const TOWER_MIN_REPAIR    = 200;
const TOWER_OPTIMAL_RANGE = 5;
const TOWER_FALLOFF_RANGE = 20;
const TOWER_FALLBACK_HPE  = 40;

const ROAD_PLAIN_DPT        = 0.1;
const ROAD_SWAMP_DPT        = 0.5;
const RAMPART_DPT           = 3.0;
const CONTAINER_OWNED_DPT   = 10.0;
const CONTAINER_UNOWNED_DPT = 50.0;

const EV_ATTACK=1,EV_OBJECT_DESTROYED=2,EV_ATTACK_CONTROLLER=3,EV_BUILD=4,
      EV_HARVEST=5,EV_HEAL=6,EV_REPAIR=7,EV_RESERVE_CONTROLLER=8,
      EV_UPGRADE_CONTROLLER=9,EV_EXIT=10,EV_POWER=11,EV_TRANSFER=12;

// ════════════════════════════════════════════════════════════════════════════
// MARKET PRICE HELPER
// ════════════════════════════════════════════════════════════════════════════

function getMarketPrice(resourceType) {
    try {
        const hist = Game.market.getHistory(resourceType) || [];
        let count = 0, sum = 0;
        if (hist.length >= 1) { const h = hist[hist.length-1]; if (h && typeof h.avgPrice==='number'){sum+=h.avgPrice;count++;} }
        if (hist.length >= 2) { const h = hist[hist.length-2]; if (h && typeof h.avgPrice==='number'){sum+=h.avgPrice;count++;} }
        return count > 0 ? sum / count : 0;
    } catch(e) { return 0; }
}

// ════════════════════════════════════════════════════════════════════════════
// SOURCE MAX RATE HELPER  (v6.15)
//
// Returns the true theoretical maximum E/tick a source can sustainably yield,
// accounting for:
//   1. Energy capacity / regen time (varies by reservation status / room type)
//   2. Active PWR_REGEN_SOURCE power-creep effect (any level)
//
// Note: snapshotted at profile start. Mid-window changes to PWR_REGEN_SOURCE
// (e.g. effect expiring without refresh) aren't tracked, but its 300-tick
// duration exceeds the 100-tick profile window so this is rarely an issue.
// ════════════════════════════════════════════════════════════════════════════

function getSourceMaxRate(source) {
    // Base regen rate from capacity:
    //   Owned/reserved sources:   3000 / 300 = 10    E/tick
    //   Unreserved/neutral:       1500 / 300 =  5    E/tick
    //   Source Keeper rooms:      4000 / 300 ≈ 13.33 E/tick
    let maxRate = (source.energyCapacity || SOURCE_ENERGY_CAPACITY) / ENERGY_REGEN_TIME;

    // PWR_REGEN_SOURCE adds energy every `period` ticks. Effect amounts:
    //   Level 1: +50  (≈3.33 E/t)   Level 4: +200 (≈13.33 E/t)
    //   Level 2: +100 (≈6.67 E/t)   Level 5: +250 (≈16.67 E/t)
    //   Level 3: +150 (≈10.00 E/t)
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

// ════════════════════════════════════════════════════════════════════════════
// ROOM VALUE CALCULATORS
// ════════════════════════════════════════════════════════════════════════════

function calcEconomicValue(room) {
    const energyPrice = getMarketPrice(RESOURCE_ENERGY);
    const labs       = room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_LAB});
    const factory    = room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_FACTORY})[0];
    const links      = room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_LINK});
    const containers = room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_CONTAINER});
    const extractor  = room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_EXTRACTOR})[0];
    const storage    = room.storage;
    const terminal   = room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_TERMINAL})[0];

    let structureEnergy = 0;
    structureEnergy += extractor ? STRUCT_COST[STRUCTURE_EXTRACTOR] : 0;
    structureEnergy += labs.length       * STRUCT_COST[STRUCTURE_LAB];
    structureEnergy += factory           ? STRUCT_COST[STRUCTURE_FACTORY] : 0;
    structureEnergy += links.length      * STRUCT_COST[STRUCTURE_LINK];
    structureEnergy += containers.length * STRUCT_COST[STRUCTURE_CONTAINER];
    const structureCredits = structureEnergy * energyPrice;

    const combatBoostSet = new Set(COMBAT_BOOSTS);
    const resourceTotals = {};
    const stores = [];
    if (storage  && storage.store)  stores.push(storage.store);
    if (terminal && terminal.store) stores.push(terminal.store);
    for (const lab of labs) if (lab.store) stores.push(lab.store);
    if (factory  && factory.store)  stores.push(factory.store);
    for (const store of stores) {
        for (const res in store) {
            if (res===RESOURCE_ENERGY || combatBoostSet.has(res) || !store[res]) continue;
            resourceTotals[res] = (resourceTotals[res]||0) + store[res];
        }
    }
    let resourceCredits = 0;
    for (const res in resourceTotals) resourceCredits += resourceTotals[res] * getMarketPrice(res);
    return { total:Math.round(structureCredits+resourceCredits), structureCredits:Math.round(structureCredits), resourceCredits:Math.round(resourceCredits) };
}

function calcMilitaryValue(room) {
    const energyPrice = getMarketPrice(RESOURCE_ENERGY);
    let structureCredits = 0, resourceCredits = 0;
    const towers   = room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_TOWER});
    const nuker    = room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_NUKER})[0];
    const ramparts = room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_RAMPART});
    const walls    = room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_WALL});
    const storage  = room.storage;
    const terminal = room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_TERMINAL})[0];
    const labs     = room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_LAB});

    let towerEnergy = towers.length * STRUCT_COST[STRUCTURE_TOWER];
    for (const t of towers) towerEnergy += (t.store&&t.store[RESOURCE_ENERGY])||0;
    structureCredits += towerEnergy * energyPrice;

    if (nuker) {
        let nukerEnergy = STRUCT_COST[STRUCTURE_NUKER] + ((nuker.store&&nuker.store[RESOURCE_ENERGY])||0);
        structureCredits += nukerEnergy * energyPrice;
        const ghodium = (nuker.store&&nuker.store[RESOURCE_GHODIUM])||0;
        if (ghodium>0) resourceCredits += ghodium * getMarketPrice(RESOURCE_GHODIUM);
    }
    let totalDefHits = 0;
    for (const d of ramparts) totalDefHits += d.hits;
    for (const d of walls)    totalDefHits += d.hits;
    structureCredits += (totalDefHits/100) * energyPrice;

    const stores = [];
    if (storage  && storage.store)  stores.push(storage.store);
    if (terminal && terminal.store) stores.push(terminal.store);
    for (const lab of labs) if (lab.store) stores.push(lab.store);
    for (const res of COMBAT_BOOSTS) {
        let amt = 0;
        for (const store of stores) { if (store[res]) amt += store[res]; }
        if (amt>0) resourceCredits += amt * getMarketPrice(res);
    }
    return { total:Math.round(structureCredits+resourceCredits), structureCredits:Math.round(structureCredits), resourceCredits:Math.round(resourceCredits) };
}

function calcDualPurposeValue(room) {
    const energyPrice = getMarketPrice(RESOURCE_ENERGY);
    let structureCredits = 0, resourceCredits = 0;
    const spawns     = room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_SPAWN});
    const extensions = room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_EXTENSION});
    const powerSpawn = room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_POWER_SPAWN})[0];
    const terminal   = room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_TERMINAL})[0];
    const storage    = room.storage;
    const observer   = room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_OBSERVER})[0];

    const structureEnergy =
        spawns.length     * STRUCT_COST[STRUCTURE_SPAWN]       +
        extensions.length * STRUCT_COST[STRUCTURE_EXTENSION]   +
        (storage    ? STRUCT_COST[STRUCTURE_STORAGE]    : 0)   +
        (terminal   ? STRUCT_COST[STRUCTURE_TERMINAL]   : 0)   +
        (powerSpawn ? STRUCT_COST[STRUCTURE_POWER_SPAWN]: 0)   +
        (observer   ? STRUCT_COST[STRUCTURE_OBSERVER]   : 0);
    structureCredits = structureEnergy * energyPrice;

    let totalEnergy = 0;
    if (storage    && storage.store)    totalEnergy += storage.store[RESOURCE_ENERGY]    || 0;
    if (terminal   && terminal.store)   totalEnergy += terminal.store[RESOURCE_ENERGY]   || 0;
    if (powerSpawn && powerSpawn.store) totalEnergy += powerSpawn.store[RESOURCE_ENERGY] || 0;
    resourceCredits += totalEnergy * energyPrice;

    let totalPower = 0;
    if (storage    && storage.store)    totalPower += storage.store[RESOURCE_POWER]    || 0;
    if (terminal   && terminal.store)   totalPower += terminal.store[RESOURCE_POWER]   || 0;
    if (powerSpawn && powerSpawn.store) totalPower += powerSpawn.store[RESOURCE_POWER] || 0;
    if (totalPower > 0) resourceCredits += totalPower * getMarketPrice(RESOURCE_POWER);

    return { total:Math.round(structureCredits+resourceCredits), structureCredits:Math.round(structureCredits), resourceCredits:Math.round(resourceCredits) };
}

// ════════════════════════════════════════════════════════════════════════════
// INLINE MAINTENANCE COST
// ════════════════════════════════════════════════════════════════════════════

function towerHPE(range) {
    if (range <= TOWER_OPTIMAL_RANGE) return TOWER_MAX_REPAIR / TOWER_ENERGY_COST;
    if (range >= TOWER_FALLOFF_RANGE) return TOWER_MIN_REPAIR / TOWER_ENERGY_COST;
    const t = (range-TOWER_OPTIMAL_RANGE)/(TOWER_FALLOFF_RANGE-TOWER_OPTIMAL_RANGE);
    return (TOWER_MAX_REPAIR - t*(TOWER_MAX_REPAIR-TOWER_MIN_REPAIR)) / TOWER_ENERGY_COST;
}

function towerHPEForStructure(s, towers) {
    if (!towers || !towers.length) return TOWER_FALLBACK_HPE;
    let minR = Infinity;
    for (const t of towers) {
        const r = Math.max(Math.abs(s.pos.x-t.pos.x), Math.abs(s.pos.y-t.pos.y));
        if (r < minR) minR = r;
    }
    return towerHPE(minR);
}

function calcMaintenance(room) {
    const towers  = room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_TOWER});
    const terrain = room.getTerrain();
    const owned   = !!(room.controller && room.controller.owner);
    let eptCreep = 0, eptTower = 0;
    for (const s of room.find(FIND_STRUCTURES)) {
        let dpt = 0;
        if      (s.structureType===STRUCTURE_ROAD)    dpt = (terrain.get(s.pos.x,s.pos.y)&TERRAIN_MASK_SWAMP) ? ROAD_SWAMP_DPT : ROAD_PLAIN_DPT;
        else if (s.structureType===STRUCTURE_RAMPART) dpt = RAMPART_DPT;
        else if (s.structureType===STRUCTURE_CONTAINER) dpt = owned ? CONTAINER_OWNED_DPT : CONTAINER_UNOWNED_DPT;
        else continue;
        eptCreep += dpt / CREEP_REPAIR_HITS;
        eptTower += dpt / towerHPEForStructure(s, towers);
    }
    return { eptCreep:Math.round(eptCreep*1000)/1000, eptTower:Math.round(eptTower*1000)/1000 };
}

// ════════════════════════════════════════════════════════════════════════════
// EFFICIENCY PROFILER — SNAPSHOT
// ════════════════════════════════════════════════════════════════════════════

function takeEffSnap(room) {
    const snap = { sources:{}, towers:{}, labs:{}, factory:null, powerSpawnPower:0, terminal:null, spawns:{}, creepPos:{}, totalCreeps:0 };
    for (const s of room.find(FIND_SOURCES)) snap.sources[s.id] = s.energy;
    for (const s of room.find(FIND_STRUCTURES)) {
        switch (s.structureType) {
            case STRUCTURE_TOWER:
                snap.towers[s.id] = s.store[RESOURCE_ENERGY];
                break;
            case STRUCTURE_LAB:
                snap.labs[s.id] = s.cooldown || 0;
                break;
            case STRUCTURE_FACTORY:
                snap.factory = { cooldown: s.cooldown||0 };
                break;
            case STRUCTURE_POWER_SPAWN:
                snap.powerSpawnPower = s.store[RESOURCE_POWER] || 0;
                break;
            case STRUCTURE_TERMINAL: {
                const store = {};
                for (const res in s.store) { if (s.store[res] > 0) store[res] = s.store[res]; }
                snap.terminal = { cooldown: s.cooldown||0, used: s.store.getUsedCapacity(), store };
                break;
            }
            case STRUCTURE_SPAWN:
                snap.spawns[s.id] = (s.spawning && s.spawning.body) ? { body: s.spawning.body.slice() } : null;
                break;
            default: break;
        }
    }
    const creeps = room.find(FIND_CREEPS);
    snap.totalCreeps = creeps.length;
    for (const c of creeps) {
        snap.creepPos[c.id] = { x:c.pos.x, y:c.pos.y };
    }
    return snap;
}

// ════════════════════════════════════════════════════════════════════════════
// EFFICIENCY PROFILER — TOTALS
// ════════════════════════════════════════════════════════════════════════════

function initEffTotals() {
    return {
        ticksObserved:0, invisibleTicks:0, energyHarvested:0, theoreticalMax:0,
        towerEnergyFired:0, spawnCostAccum:0, upgradeEnergySpent:0,
        creepMoves:0, creepCountSum:0, totalIntents:0, productiveIntents:0, buildTicks:0,
        ev_harvest:0, ev_upgradeController:0, ev_build:0, ev_transfer:0,
        ev_repairAny:0, ev_attack:0, ev_heal:0, ev_power:0,
        terminalSends:0, terminalFlux:0,
        terminalIn:{}, terminalOut:{},
        labReactions:0, factoryProduces:0, spawnEvents:0,
        labCount:0, hasLabs:false, hasFactory:false, hasTerminal:false,
        sourceCount:0, sourcePositions:{},
        sourceStartEnergy:{}, sourceExtracted:{}, sourceRegen:{},
        sourceDepleted:{}, sourceRegenTicks:{},
        sourceMaxRates:{},                 // v6.15: per-source true E/tick ceiling
        sourceHarvested:{},                // v6.16: per-source energy from EV_HARVEST events
        maintEptCreep:0,
    };
}

// ════════════════════════════════════════════════════════════════════════════
// EFFICIENCY PROFILER — ACCUMULATE  (v6.15)
//
// Source extraction uses raw energy drop (prevE - currE). Regen ticks
// (currE > prevE) yield a negative drop which max(0,…) discards — no
// phantom energy invented.
//
// Depletion fires only on a witnessed transition to 0 (prevE > 0 && currE === 0)
// so a source that was already empty at profile start doesn't get free credit.
//
// theoreticalMax sums per-source max rates (so a level-5 PWR_REGEN_SOURCE
// source contributes ~26.67 E/t to the ceiling, not 10).
// ════════════════════════════════════════════════════════════════════════════

function accumulate(prev, curr, room, totals) {

    for (const srcId in totals.sourcePositions) {
        const prevE = prev.sources[srcId] !== undefined ? prev.sources[srcId] : 0;
        const currE = curr.sources[srcId] !== undefined ? curr.sources[srcId] : 0;

        if (currE > prevE) {
            // Regen tick: source refilled. Drop is zero; count the tick so we
            // can exclude it from the rate denominator in analyzeOperational.
            totals.sourceRegenTicks[srcId] = (totals.sourceRegenTicks[srcId] || 0) + 1;
        } else {
            // Normal tick: record raw energy drop (zero if nothing was harvested).
            const drop = Math.max(0, prevE - currE);
            totals.sourceExtracted[srcId] = (totals.sourceExtracted[srcId] || 0) + drop;
        }

        // Only mark depleted when we witness the source transition to 0.
        if (currE === 0 && prevE > 0) {
            totals.sourceDepleted[srcId] = true;
        }
    }

    for (const id in curr.towers) {
        if (prev.towers[id] !== undefined)
            totals.towerEnergyFired += Math.max(0, prev.towers[id]-curr.towers[id]);
    }
    for (const id in curr.labs)
        if (prev.labs[id]===0 && curr.labs[id]>0) totals.labReactions++;
    if (curr.factory && prev.factory && prev.factory.cooldown===0 && curr.factory.cooldown>0)
        totals.factoryProduces++;

    if (curr.terminal && prev.terminal) {
        if (prev.terminal.cooldown===0 && curr.terminal.cooldown>0) totals.terminalSends++;
        totals.terminalFlux += Math.abs(curr.terminal.used - prev.terminal.used);

        const allRes = new Set([
            ...Object.keys(prev.terminal.store || {}),
            ...Object.keys(curr.terminal.store || {}),
        ]);
        for (const res of allRes) {
            const prevAmt = (prev.terminal.store||{})[res] || 0;
            const currAmt = (curr.terminal.store||{})[res] || 0;
            const delta   = currAmt - prevAmt;
            if (delta > 0)       totals.terminalIn[res]  = (totals.terminalIn[res]  || 0) + delta;
            else if (delta < 0)  totals.terminalOut[res] = (totals.terminalOut[res] || 0) + (-delta);
        }
    }

    for (const id in curr.spawns) {
        if (curr.spawns[id] && !prev.spawns[id]) {
            let cost = 0;
            for (const p of curr.spawns[id].body) cost += BODYPART_COST_MAP[p.type] || 0;
            totals.spawnCostAccum += cost;
            totals.spawnEvents++;
        }
    }
    for (const id in curr.creepPos) {
        const c = curr.creepPos[id], p = prev.creepPos[id];
        if (p && (c.x!==p.x || c.y!==p.y)) totals.creepMoves++;
    }
    totals.creepCountSum += curr.totalCreeps;

    let events;
    try   { events = JSON.parse(room.getEventLog(true)); }
    catch { events = room.getEventLog(); }
    let hadBuild = false;
    if (events && events.length) {
        for (const ev of events) {
            switch (ev.event) {
                case EV_HARVEST:
                    totals.ev_harvest++;
                    totals.totalIntents++;
                    totals.productiveIntents++;
                    if (ev.data && typeof ev.data.amount === 'number' && ev.data.resourceType === RESOURCE_ENERGY) {
                        totals.energyHarvested += ev.data.amount;
                        // v6.16: attribute to source for accurate per-source rate.
                        // Snapshot diffs (sourceExtracted) silently drop ticks where
                        // PWR_REGEN_SOURCE refills the source while harvesting also
                        // happens (currE > prevE → "regen tick"); the event log records
                        // the actual amount harvested regardless.
                        const targetId = ev.data.targetId;
                        if (targetId && totals.sourceMaxRates[targetId] !== undefined) {
                            totals.sourceHarvested[targetId] = (totals.sourceHarvested[targetId] || 0) + ev.data.amount;
                        }
                    }
                    break;
                case EV_UPGRADE_CONTROLLER:
                    totals.ev_upgradeController++;
                    totals.totalIntents++;
                    totals.productiveIntents++;
                    totals.upgradeEnergySpent += (ev.data && typeof ev.data.amount==='number') ? ev.data.amount : 1;
                    break;
                case EV_BUILD:
                    totals.ev_build++;
                    totals.totalIntents++;
                    totals.productiveIntents++;
                    hadBuild = true;
                    break;
                case EV_TRANSFER:
                    totals.ev_transfer++;
                    totals.totalIntents++;
                    totals.productiveIntents++;
                    break;
                case EV_REPAIR:
                    totals.ev_repairAny++;
                    totals.totalIntents++;
                    break;
                case EV_ATTACK:
                    totals.ev_attack++;
                    totals.totalIntents++;
                    break;
                case EV_HEAL:
                    totals.ev_heal++;
                    totals.totalIntents++;
                    break;
                case EV_POWER:
                    totals.ev_power++;
                    totals.totalIntents++;
                    totals.productiveIntents++;
                    break;
                case EV_ATTACK_CONTROLLER:
                case EV_RESERVE_CONTROLLER:
                    totals.totalIntents++;
                    break;
                default: break;
            }
        }
    }
    if (hadBuild) totals.buildTicks++;
    totals.ticksObserved++;

    // v6.15: theoreticalMax sums each source's true max rate.
    let tickMax = 0;
    for (const srcId in totals.sourceMaxRates) tickMax += totals.sourceMaxRates[srcId];
    totals.theoreticalMax += tickMax;
}

// ════════════════════════════════════════════════════════════════════════════
// EFFICIENCY PROFILER — LIFECYCLE
// ════════════════════════════════════════════════════════════════════════════

function getEffPrev(rn)    { return global[EFF_GLOBAL_PREV] && global[EFF_GLOBAL_PREV][rn] || null; }
function setEffPrev(rn,s)  { if (!global[EFF_GLOBAL_PREV]) global[EFF_GLOBAL_PREV]={}; global[EFF_GLOBAL_PREV][rn]=s; }
function clearEffPrev(rn)  { if (global[EFF_GLOBAL_PREV]) delete global[EFF_GLOBAL_PREV][rn]; }

function startEffProfile(roomName, room) {
    if (!Memory[EFF_MEM_KEY]) Memory[EFF_MEM_KEY] = {};
    if (Memory[EFF_MEM_KEY][roomName] && Memory[EFF_MEM_KEY][roomName].active) return;
    const maint   = calcMaintenance(room);
    const labs    = room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_LAB});
    const factory = room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_FACTORY})[0];
    const term    = room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_TERMINAL})[0];
    const sources = room.find(FIND_SOURCES);
    const totals  = initEffTotals();
    totals.maintEptCreep = maint.eptCreep;
    totals.labCount      = labs.length;
    totals.hasLabs       = labs.length > 0;
    totals.hasFactory    = !!factory;
    totals.hasTerminal   = !!term;
    totals.sourceCount   = sources.length;
    for (const s of sources) {
        totals.sourcePositions[s.id]   = { x: s.pos.x, y: s.pos.y };
        totals.sourceStartEnergy[s.id] = s.energy;
        totals.sourceExtracted[s.id]   = 0;
        totals.sourceRegen[s.id]       = 0;
        totals.sourceDepleted[s.id]    = false;
        totals.sourceRegenTicks[s.id]  = 0;
        totals.sourceMaxRates[s.id]    = getSourceMaxRate(s);   // v6.15
        totals.sourceHarvested[s.id]   = 0;                     // v6.16
    }

    Memory[EFF_MEM_KEY][roomName] = { active:true, roomName, startTick:Game.time, totals };
    fireObserversForRoom(roomName);
    console.log('[Intel] 📊 Efficiency profile started — ' + roomName + ' (' + PROFILE_TICKS + ' ticks)');
}

function fireObserversForRoom(roomName) {
    const obs = findObserversInRange(roomName);
    let fired = 0;
    for (const o of obs.slice(0,2)) { if (o.observeRoom(roomName)===OK) fired++; }
    return fired;
}

function processEfficiencyProfiles() {
    if (!Memory[EFF_MEM_KEY]) return;
    for (const roomName in Memory[EFF_MEM_KEY]) {
        const profile = Memory[EFF_MEM_KEY][roomName];
        if (!profile || !profile.active) continue;
        if (!isOwnRoom(roomName)) fireObserversForRoom(roomName);
        const room = Game.rooms[roomName];
        if (!room) { profile.totals.invisibleTicks++; continue; }
        const curr = takeEffSnap(room);
        const prev = getEffPrev(roomName);
        if (!prev) { setEffPrev(roomName, curr); continue; }
        accumulate(prev, curr, room, profile.totals);
        setEffPrev(roomName, curr);
        const obs = profile.totals.ticksObserved;
        if (obs>0 && obs%25===0 && obs<PROFILE_TICKS)
            console.log('[Intel] 📊 ' + roomName + ' efficiency: ' + obs + '/' + PROFILE_TICKS + ' ticks');
        if (obs >= PROFILE_TICKS) _finaliseEffProfile(roomName, profile);
    }
}

function calcEffCPU(t) {
    const CPU_SIMPLE=0.2, CPU_ELEV=0.4, CPU_MOVE=0.5;
    const simpleIntents = (t.ev_harvest||0)+(t.ev_upgradeController||0)+(t.ev_build||0)+
                          (t.ev_transfer||0)+(t.ev_power||0)+(t.terminalSends||0)+
                          (t.factoryProduces||0)+(t.spawnEvents||0);
    const totalMid    = simpleIntents*CPU_SIMPLE + (t.labReactions||0)*CPU_ELEV +
                        (t.ev_repairAny||0)*CPU_ELEV + ((t.ev_attack||0)+(t.ev_heal||0))*CPU_SIMPLE +
                        (t.creepMoves||0)*CPU_MOVE;
    const cpuPerCreep = (t.creepCountSum||0)>0 ? totalMid/t.creepCountSum : null;
    return { totalMid, cpuPerCreep };
}

function _finaliseEffProfile(roomName, profile) {
    if (!Memory[EFF_CACHE_KEY]) Memory[EFF_CACHE_KEY] = {};
    Memory[EFF_CACHE_KEY][roomName] = { totals:profile.totals, completedTick:Game.time, expiresTick:Game.time+EFF_EXPIRE };
    clearEffPrev(roomName);
    delete Memory[EFF_MEM_KEY][roomName];
    console.log('[Intel] 📊 Efficiency profile complete — ' + roomName +
        ' (' + profile.totals.ticksObserved + ' ticks observed). Generating full report...');
    if (Game.rooms[roomName]) intel(roomName);
    else console.log('[Intel] ' + roomName + ' not visible this tick — call intel(\'' + roomName + '\') manually.');
}

function getCachedEff(roomName) {
    if (!Memory[EFF_CACHE_KEY] || !Memory[EFF_CACHE_KEY][roomName]) return null;
    const c = Memory[EFF_CACHE_KEY][roomName];
    if (c.expiresTick <= Game.time) { delete Memory[EFF_CACHE_KEY][roomName]; return null; }
    return c;
}

function isProfilingEff(roomName) {
    return !!(Memory[EFF_MEM_KEY] && Memory[EFF_MEM_KEY][roomName] && Memory[EFF_MEM_KEY][roomName].active);
}

// ════════════════════════════════════════════════════════════════════════════
// TERMINAL FLOW FORMATTER
// ════════════════════════════════════════════════════════════════════════════

function buildTerminalFlowLines(t, prefix) {
    if (!t.hasTerminal) return [prefix + '   Terminal not present during profile.'];

    const allRes = new Set([
        ...Object.keys(t.terminalIn  || {}),
        ...Object.keys(t.terminalOut || {}),
    ]);
    if (allRes.size === 0)
        return [prefix + '   No terminal movements detected over ' + t.ticksObserved + ' ticks.'];

    const rows = [];
    for (const res of allRes) {
        const inAmt  = (t.terminalIn  || {})[res] || 0;
        const outAmt = (t.terminalOut || {})[res] || 0;
        const price  = getMarketPrice(res);
        const inVal  = inAmt  * price;
        const outVal = outAmt * price;
        rows.push({ res, inAmt, outAmt, inVal, outVal, price, totalVal: inVal + outVal });
    }
    rows.sort((a, b) => b.totalVal - a.totalVal);

    const lines = [];
    lines.push(prefix + 'Terminal Flow (' + t.ticksObserved + '-tick window, sorted by value):');
    for (const row of rows) {
        const priceStr = row.price > 0 ? '@' + r2(row.price) + 'cr' : '@?cr';
        if (row.inAmt > 0)
            lines.push(prefix + '  ▲ IN  ' + row.res.padEnd(12) + ' ×' + fmtNum(row.inAmt).padStart(7) + ' ' + priceStr + ' = ' + fmtCredits(row.inVal).padStart(10));
        if (row.outAmt > 0)
            lines.push(prefix + '  ▼ OUT ' + row.res.padEnd(12) + ' ×' + fmtNum(row.outAmt).padStart(7) + ' ' + priceStr + ' = ' + fmtCredits(row.outVal).padStart(10));
        if (row.inAmt > 0 && row.outAmt > 0) {
            const net = row.inAmt - row.outAmt;
            const dir = net > 0 ? '▲' : net < 0 ? '▼' : '=';
            lines.push(prefix + '         net: ' + dir + ' ' + fmtNum(Math.abs(net)) + ' ' + row.res);
        }
    }
    const totalIn  = rows.reduce((s, r) => s + r.inVal,  0);
    const totalOut = rows.reduce((s, r) => s + r.outVal, 0);
    lines.push(prefix + '  ──────────────────────────────────────────────');
    lines.push(prefix + '  Total IN value : ' + fmtCredits(totalIn));
    lines.push(prefix + '  Total OUT value: ' + fmtCredits(totalOut));
    lines.push(prefix + '  Net throughput : ' + fmtCredits(totalIn + totalOut) + ' over window');
    return lines;
}

// ════════════════════════════════════════════════════════════════════════════
// ROOM PURPOSE CLASSIFIER
// ════════════════════════════════════════════════════════════════════════════

function classifyPurpose(room, t) {
    const obs          = Math.max(1, t.ticksObserved);
    const rcl          = room.controller ? room.controller.level : 0;
    const upgradeRate  = t.ev_upgradeController / obs;
    const buildRate    = t.ev_build / obs;
    const harvestRate  = t.ev_harvest / obs;
    const transferRate = t.ev_transfer / obs;
    const powerEvents  = t.ev_power;
    const incomePerTick = t.energyHarvested / obs;
    const upgradeEnergy = t.upgradeEnergySpent / obs;
    const upgradeFrac   = incomePerTick > 0 ? upgradeEnergy / incomePerTick : 0;
    const termSendRate  = t.terminalSends / obs;
    const boostedCreeps = room.find(FIND_CREEPS).filter(c => c.body.some(p => p.boost));
    const underAttack   = t.ev_attack > 5;

    if (powerEvents > 10 && upgradeFrac < 0.40)                                          return 'Power Processing';
    if (upgradeFrac >= 0.60 && upgradeRate > 0.50)                                       return rcl===8 ? 'GCL Push' : 'RCL Push';
    if (boostedCreeps.length > 0 && underAttack)                                         return 'Combat Staging';
    if (t.hasFactory && t.factoryProduces > 2 && termSendRate > 0.03)                    return 'Factory Hub';
    if (buildRate > 0.30 && upgradeFrac < 0.30)                                          return 'Active Expansion';
    if (harvestRate > 0.50 && transferRate > 0.30 && !t.hasFactory && upgradeRate < 0.20) return 'Source Room';
    return 'Balanced Operation';
}

// ════════════════════════════════════════════════════════════════════════════
// OPERATIONAL EFFICIENCY SCORING  (v6.16)
//
// Capture scoring uses event-attributed per-source extraction:
//   fraction = sourceHarvested / (ticksObserved × sourceMaxRate)
//   Final capture score = average fraction × 25.
//
// Switching from snapshot-diff to EV_HARVEST events fixes a v6.15 bug where
// a source briefly hitting 0 (common with strong harvesters between
// PWR_REGEN_SOURCE pulses) flagged the source as 100% captured even when
// actual extraction was much lower than the ceiling — and where the snapshot
// also undercounted extraction during regen ticks, producing an inconsistency
// like "income 36.8/46.7 E/t but capture 100%".
//
// Per-source max rate (snapshotted at profile start) = base capacity regen
// + any active PWR_REGEN_SOURCE bonus, so the ceiling is correct whether
// the source is in an unreserved room (5 E/t), a normal owned room (10 E/t),
// an SK room (~13 E/t), or boosted by power creeps (up to ~26 E/t at L5).
//
// Income shares the same data: total harvested / obs, capped at sum of
// per-source max rates. Income and fractions can no longer disagree.
// ════════════════════════════════════════════════════════════════════════════

function analyzeOperational(room, effCache) {
    let score = 0;
    const positives = {}, negatives = {}, details = {};
    const t   = effCache.totals;
    const obs = Math.max(1, t.ticksObserved);

    // ── 1. Energy Capture (25 pts) ──────────────────────────────────────────
    // v6.16: per-source extraction is attributed from EV_HARVEST events (which
    // remain accurate when PWR_REGEN_SOURCE refills the source mid-tick), and
    // both per-source fractions and total income share the same denominator
    // (obs ticks) so they can no longer disagree.
    const perSourceFractions = [];
    const perSourceRates     = [];   // for diagnostics output
    const sourceHarv         = t.sourceHarvested || {};
    for (const srcId in t.sourcePositions) {
        const harvested = sourceHarv[srcId] || 0;
        const maxRate   = t.sourceMaxRates[srcId] || 10;
        const fraction  = Math.min(1, harvested / (obs * maxRate));
        perSourceFractions.push(fraction);
        perSourceRates.push(maxRate);
    }

    const avgFraction = perSourceFractions.length > 0
        ? perSourceFractions.reduce((s, v) => s + v, 0) / perSourceFractions.length
        : 0;
    const captureScore = Math.min(25, avgFraction * 25);
    if (captureScore > 0) { positives.energyCaptureRate = r1(captureScore); score += captureScore; }

    // Income: sum per-source harvested totals (event-attributed, accurate with
    // PWR_REGEN_SOURCE), cap at sum of per-source max rates.
    const totalHarvested        = Object.values(sourceHarv).reduce((s, v) => s + v, 0);
    const maxSustainableIncome  = Object.values(t.sourceMaxRates).reduce((s, v) => s + v, 0);
    const sustainableIncomeRate = Math.min(totalHarvested / obs, maxSustainableIncome);
    const sustainedUtil         = maxSustainableIncome > 0 ? sustainableIncomeRate / maxSustainableIncome : 0;

    details.energyCaptureRate    = r1(avgFraction * 100) + '%';
    details.sustainedUtilization = r1(sustainedUtil * 100) + '%';
    details.energyHarvested      = Math.round(totalHarvested);
    details.incomePerTick        = r1(sustainableIncomeRate);
    details.maxIncomePerTick     = r1(maxSustainableIncome);
    details.sourceFractions      = perSourceFractions.map(f => r1(f * 100) + '%').join(', ');
    details.sourceMaxRates       = perSourceRates.map(r => r1(r) + ' E/t').join(', ');

    // ── 2. Income Surplus (20 pts) ──────────────────────────────────────────
    const spendPerTick   = t.maintEptCreep + t.spawnCostAccum/obs + t.upgradeEnergySpent/obs + t.towerEnergyFired/obs;
    const surplusPerTick = sustainableIncomeRate - spendPerTick;
    const surplusFrac    = sustainableIncomeRate > 0 ? surplusPerTick / sustainableIncomeRate : 0;

    let surplusScore = 0;
    if (surplusFrac >= 0) {
        if      (surplusFrac <= 0.50) surplusScore = 20;
        else if (surplusFrac <= 0.80) surplusScore = 20 - ((surplusFrac-0.50)/0.30)*10;
        else                          surplusScore = Math.max(4, 10 - ((surplusFrac-0.80)/0.20)*6);
        positives.incomeSurplus = r1(surplusScore); score += surplusScore;
    }
    details.spendPerTick     = r2(spendPerTick);
    details.surplusPerTick   = r1(surplusPerTick);
    details.surplusFrac      = r1(surplusFrac*100) + '%';
    details.maintPerTick     = r2(t.maintEptCreep);
    details.spawnPerTick     = r1(t.spawnCostAccum/obs);
    details.upgradePerTick   = r1(t.upgradeEnergySpent/obs);
    details.towerCostPerTick = r1(t.towerEnergyFired/obs);

    // ── 3. CPU/Creep (16 pts) ───────────────────────────────────────────────
    const effCPU = calcEffCPU(t);
    const cpuPerCreep = effCPU.cpuPerCreep;
    if (cpuPerCreep !== null) {
        const cpuScore = Math.max(0, 16*(1-cpuPerCreep/0.50));
        if (cpuScore > 0) { positives.cpuEfficiency = r1(cpuScore); score += cpuScore; }
    }
    details.cpuPerCreep = cpuPerCreep !== null ? r3(cpuPerCreep) : 'n/a';
    details.cpuTotalMid = cpuPerCreep !== null ? r2(effCPU.totalMid) : 0;

    // ── 4. Productive Intent Ratio (13 pts) ─────────────────────────────────
    const totalWithMoves = t.totalIntents + t.creepMoves;
    const prodRatio      = totalWithMoves > 0 ? t.productiveIntents/totalWithMoves : 0;
    const prodScore      = prodRatio * 13;
    if (prodScore > 0) { positives.productiveIntentRatio = r1(prodScore); score += prodScore; }
    details.productiveRatio      = r1(prodRatio*100) + '%';
    details.productiveIntents    = t.productiveIntents;
    details.totalIntents         = totalWithMoves;
    details.ev_harvest           = t.ev_harvest           || 0;
    details.ev_build             = t.ev_build             || 0;
    details.ev_upgradeController = t.ev_upgradeController || 0;
    details.ev_transfer          = t.ev_transfer          || 0;
    details.ev_repairAny         = t.ev_repairAny         || 0;
    details.ev_attack            = t.ev_attack            || 0;
    details.ev_heal              = t.ev_heal              || 0;
    details.ev_power             = t.ev_power             || 0;

    // ── 5. Creep Repair Share (13 pts) ──────────────────────────────────────
    const towerRepairActions = Math.floor(t.towerEnergyFired / TOWER_ENERGY_COST);
    const creepRepairActions = Math.max(0, t.ev_repairAny - towerRepairActions);
    let creepRepairShare;
    if (t.ev_repairAny === 0) {
        creepRepairShare = null; positives.creepRepairShare = 6; score += 6;
    } else {
        creepRepairShare = creepRepairActions / t.ev_repairAny;
        const repairScore = creepRepairShare * 13;
        if (repairScore > 0) { positives.creepRepairShare = r1(repairScore); score += repairScore; }
    }
    details.towerRepairActions = towerRepairActions;
    details.creepRepairActions = creepRepairActions;
    details.totalRepairEvents  = t.ev_repairAny;
    details.creepRepairShare   = creepRepairShare !== null ? r1(creepRepairShare*100) + '%' : 'N/A';

    // ── 6. Low Moves/Creep/Tick (13 pts) ────────────────────────────────────
    const avgCreeps         = t.creepCountSum / obs;
    const movesPerCreepTick = avgCreeps > 0 ? t.creepMoves/(avgCreeps*obs) : 0;
    const moveScore         = Math.max(0, 13*(1-movesPerCreepTick/1.0));
    if (moveScore > 0) { positives.lowMovesPerCreep = r1(moveScore); score += moveScore; }
    if (movesPerCreepTick < 0.1) {
        positives.efficientMovementBonus = 3; score += 3;
    }
    if (movesPerCreepTick > 0.4) {
        if (movesPerCreepTick > 0.7) { negatives.highMovesPerCreep = -10; score -= 10; }
        else                         { negatives.moderateMovesPerCreep = -5; score -= 5; }
    }
    details.movesPerCreepTick = r3(movesPerCreepTick);
    details.totalCreepMoves   = t.creepMoves;
    details.avgCreeps         = r1(avgCreeps);

    details.buildRate    = r3(t.ev_build/obs) + '/tick';
    details.harvestRate  = r3(t.ev_harvest/obs) + '/tick';
    details.upgradeRate  = r3(t.ev_upgradeController/obs) + '/tick';
    details.transferRate = r3(t.ev_transfer/obs) + '/tick';
    details.ticksObserved  = t.ticksObserved;
    details.invisibleTicks = t.invisibleTicks;

    details.terminalIn  = t.terminalIn  || {};
    details.terminalOut = t.terminalOut || {};
    details.hasTerminal = t.hasTerminal;

    // ── Penalties ────────────────────────────────────────────────────────────
    if (surplusFrac < 0) { negatives.energyDeficit = -15; score -= 15; }
    if (cpuPerCreep !== null && cpuPerCreep >= 0.40) { negatives.highCpuPerCreep = -10; score -= 10; }
    if (t.ev_repairAny > 0 && creepRepairShare !== null && creepRepairShare < 0.30) { negatives.towerRepairDominant = -8; score -= 8; }
    if (t.buildTicks >= obs*0.95) { negatives.sustainedBuildActivity = -5; score -= 5; }

    score = Math.max(0, Math.min(100, score));
    return { score, positives, negatives, details };
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN INTEL FUNCTION
// ════════════════════════════════════════════════════════════════════════════

function intel(roomName) {
    if (!roomName || typeof roomName !== 'string') { console.log('[Intel] ERROR: Usage: intel("W1N1")'); return; }
    if (!Memory.roomIntelPending) Memory.roomIntelPending = {};
    const room = Game.rooms[roomName];

    if (!room) {
        const pending = Memory.roomIntelPending[roomName];
        if (pending && Game.time-pending.tick <= 1) {
            console.log('[Intel] ERROR: ' + roomName + ' still not visible after observation attempt.');
            delete Memory.roomIntelPending[roomName]; return;
        }
        if (Memory.intelPowerObserve && Memory.intelPowerObserve[roomName]) {
            const po = Memory.intelPowerObserve[roomName];
            if (Game.time-po.tick <= 50) { console.log('[Intel] ⏳ PWR_OPERATE_OBSERVER in progress — ' + po.operatorName + ', elapsed ' + (Game.time-po.tick) + ' ticks.'); return; }
            delete Memory.intelPowerObserve[roomName];
        }
        const obs = findBestObserver(roomName);
        if (obs && obs.observeRoom(roomName)===OK) {
            Memory.roomIntelPending[roomName] = { tick:Game.time, observerRoom:obs.room.name };
            console.log('[Intel] 🔭 Observing ' + roomName + ' from ' + obs.room.name + '. Run intel(\'' + roomName + '\') again next tick.');
            return;
        }
        try {
            const roleOp = require('roleOperator');
            const po = roleOp.findPowerObserver(roomName);
            if (po) {
                if (!Memory.intelPowerObserve) Memory.intelPowerObserve = {};
                Memory.intelPowerObserve[roomName] = { operatorName:po.operatorName, operatorRoom:po.operatorRoom, tick:Game.time };
                console.log('[Intel] 🔭⚡ Requesting PWR_OPERATE_OBSERVER from ' + po.operatorName + ' (' + po.operatorRoom + ')');
                return;
            }
        } catch(e) {}
        console.log('[Intel] ERROR: ' + roomName + ' not visible. No observer in range. Send a scout.');
        return;
    }
    delete Memory.roomIntelPending[roomName];

    const effCache  = getCachedEff(roomName);
    const profiling = isProfilingEff(roomName);
    if (!effCache && !profiling) {
        startEffProfile(roomName, room);
        console.log('[Intel] ⏳ ' + roomName + ' — profile started. Full report auto-prints in ~' + PROFILE_TICKS + ' ticks.');
        return;
    }
    if (!effCache && profiling) {
        const p = Memory[EFF_MEM_KEY][roomName];
        console.log('[Intel] ⏳ ' + roomName + ' — profiling ' + (p?p.totals.ticksObserved:0) + '/' + PROFILE_TICKS + ' ticks. Report auto-prints when complete.');
        return;
    }

    const ecoData = analyzeEconomic(room, effCache);
    const milData = analyzeMilitary(room);
    const dpData  = analyzeDualPurpose(room);
    const opData  = analyzeOperational(room, effCache);
    const purpose = classifyPurpose(room, effCache.totals);
    const ecoScore = clamp(ecoData.score), milScore = clamp(milData.score),
          dpScore  = clamp(dpData.score),  opScore  = clamp(opData.score);
    const overall = ecoScore*W.economic + milScore*W.military + dpScore*W.dualPurpose + opScore*W.operational;

    const ecoVal = calcEconomicValue(room), milVal = calcMilitaryValue(room), dpVal = calcDualPurposeValue(room);
    const totalVal = ecoVal.total + milVal.total + dpVal.total;

    const result = {
        room:roomName, owner:room.controller&&room.controller.owner?room.controller.owner.username:'Unowned',
        rcl:room.controller?room.controller.level:0, tick:Game.time, overall:r1(overall),
        totalValue:totalVal, purpose,
        economic:   {score:r1(ecoScore),value:ecoVal,positives:ecoData.positives,negatives:ecoData.negatives,details:ecoData.details},
        military:   {score:r1(milScore),value:milVal,positives:milData.positives,negatives:milData.negatives,details:milData.details},
        dualPurpose:{score:r1(dpScore), value:dpVal, positives:dpData.positives, negatives:dpData.negatives, details:dpData.details},
        operational:{score:r1(opScore),              positives:opData.positives, negatives:opData.negatives, details:opData.details},
    };

    if (!Memory.roomIntel) Memory.roomIntel = {};
    Memory.roomIntel[roomName] = result;
    printReport(result);
    delete Memory.roomIntel[roomName];
    if (Memory[EFF_CACHE_KEY]) delete Memory[EFF_CACHE_KEY][roomName];
}

// ════════════════════════════════════════════════════════════════════════════
// FAST INTEL
// ════════════════════════════════════════════════════════════════════════════

function intelFast(roomName, silent=false) {
    if (!roomName || typeof roomName !== 'string') { console.log('[IntelFast] ERROR: Usage: intelFast("W1N1")'); return null; }
    if (!Memory.roomIntelPending) Memory.roomIntelPending = {};
    const room = Game.rooms[roomName];

    if (!room) {
        const pending = Memory.roomIntelPending[roomName];
        if (pending && Game.time-pending.tick <= 1) {
            console.log('[IntelFast] ERROR: ' + roomName + ' still not visible after observation attempt.');
            delete Memory.roomIntelPending[roomName]; return null;
        }
        if (Memory.intelPowerObserve && Memory.intelPowerObserve[roomName]) {
            const po = Memory.intelPowerObserve[roomName];
            if (Game.time-po.tick <= 50) { console.log('[IntelFast] ⏳ PWR_OPERATE_OBSERVER in progress — ' + po.operatorName + ', elapsed ' + (Game.time-po.tick) + ' ticks.'); return null; }
            delete Memory.intelPowerObserve[roomName];
        }
        const obs = findBestObserver(roomName);
        if (obs && obs.observeRoom(roomName)===OK) {
            Memory.roomIntelPending[roomName] = { tick:Game.time, observerRoom:obs.room.name, fast:true };
            console.log('[IntelFast] 🔭 Observing ' + roomName + ' from ' + obs.room.name + '. Report will auto-print next tick.');
            return null;
        }
        try {
            const roleOp = require('roleOperator');
            const po = roleOp.findPowerObserver(roomName);
            if (po) {
                if (!Memory.intelPowerObserve) Memory.intelPowerObserve = {};
                Memory.intelPowerObserve[roomName] = { operatorName:po.operatorName, operatorRoom:po.operatorRoom, tick:Game.time, fast:true };
                console.log('[IntelFast] 🔭⚡ Requesting PWR_OPERATE_OBSERVER from ' + po.operatorName + ' (' + po.operatorRoom + ')');
                return null;
            }
        } catch(e) {}
        console.log('[IntelFast] ERROR: ' + roomName + ' not visible. No observer in range. Send a scout.');
        return null;
    }
    delete Memory.roomIntelPending[roomName];

    const ecoData = analyzeEconomic(room, null), milData = analyzeMilitary(room), dpData = analyzeDualPurpose(room);
    const ecoScore = clamp(ecoData.score), milScore = clamp(milData.score), dpScore = clamp(dpData.score);
    const overall  = ecoScore*W_FAST.economic + milScore*W_FAST.military + dpScore*W_FAST.dualPurpose;
    const ecoVal = calcEconomicValue(room), milVal = calcMilitaryValue(room), dpVal = calcDualPurposeValue(room);

    const result = {
        room:roomName, owner:room.controller&&room.controller.owner?room.controller.owner.username:'Unowned',
        rcl:room.controller?room.controller.level:0, tick:Game.time, overall:r1(overall),
        totalValue:ecoVal.total+milVal.total+dpVal.total, fast:true,
        economic:   {score:r1(ecoScore),value:ecoVal,positives:ecoData.positives,negatives:ecoData.negatives,details:ecoData.details},
        military:   {score:r1(milScore),value:milVal,positives:milData.positives,negatives:milData.negatives,details:milData.details},
        dualPurpose:{score:r1(dpScore), value:dpVal, positives:dpData.positives, negatives:dpData.negatives, details:dpData.details},
    };
    if (!silent) printFastReport(result);
    return result;
}

// ════════════════════════════════════════════════════════════════════════════
// ECONOMIC  (20%)
// ════════════════════════════════════════════════════════════════════════════

function analyzeEconomic(room, effCache) {
    let score = 0;
    const pos={}, neg={}, det={};
    const factory   = room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_FACTORY})[0];
    const extractor = room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_EXTRACTOR})[0];
    const storage   = room.storage;
    const terminal  = room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_TERMINAL})[0];
    const links     = room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_LINK});
    const labs      = room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_LAB});
    const containers= room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_CONTAINER});
    const sources   = room.find(FIND_SOURCES);
    const mineral   = room.find(FIND_MINERALS)[0];

    const allRes = new Set();
    if (storage  && storage.store)  Object.keys(storage.store).filter(k=>storage.store[k]>0).forEach(k=>allRes.add(k));
    if (terminal && terminal.store) Object.keys(terminal.store).filter(k=>terminal.store[k]>0).forEach(k=>allRes.add(k));

    if (factory) {
        pos.factoryExists=5; score+=5; det.factoryExists=true;
        const lvl=factory.level||0;
        if (lvl>=1) { pos.factoryLeveled=5; score+=5; }
        det.factoryLevel=lvl;
    } else { det.factoryExists=false; det.factoryLevel=0; }

    if (extractor) {
        pos.extractorExists=3; score+=3; det.extractorExists=true;
        let active=false;
        if (mineral) active = mineral.mineralAmount===0 || mineral.pos.findInRange(FIND_CREEPS,1).length>0;
        if (active) { pos.extractorActive=7; score+=7; }
        det.extractorActive=active;
    } else { det.extractorExists=false; det.extractorActive=false; }
    if (mineral) { det.mineralType=mineral.mineralType; det.mineralAmount=mineral.mineralAmount; }

    const nonEnergy = new Set(); allRes.forEach(r=>{ if (r!==RESOURCE_ENERGY) nonEnergy.add(r); });
    const diversity = nonEnergy.size;
    if (diversity>0) { const ds=Math.min(25,diversity)/25*13; pos.storageDiversity=r1(ds); score+=ds; }
    det.storageDiversityCount=diversity;

    if (links.length>0) { const ls=Math.min(links.length/4,1)*13; pos.linkCount=r1(ls); score+=ls; }
    det.linkCount=links.length;

    if (labs.length>0) { const labS=Math.min(labs.length/10,1)*5; pos.labCount=r1(labS); score+=labS; }
    const activeLabs=labs.filter(l=>l.cooldown>0||(l.mineralType&&l.store[l.mineralType]>0));
    if (activeLabs.length>0&&labs.length>0) { const als=Math.min(activeLabs.length/labs.length,1)*5; pos.labsActive=r1(als); score+=als; }
    det.labCount=labs.length; det.activeLabCount=activeLabs.length;

    const roomOrders=Game.market.getAllOrders({roomName:room.name}).filter(o=>o.roomName===room.name);
    const buys=roomOrders.filter(o=>o.type===ORDER_BUY), sells=roomOrders.filter(o=>o.type===ORDER_SELL);
    det.marketTotalOrders=roomOrders.length; det.marketBuyOrders=buys.length; det.marketSellOrders=sells.length;
    det.sellOrderDetails=sells.map(o=>({resource:o.resourceType,amount:o.remainingAmount,price:o.price}));
    det.buyOrderDetails =buys.map(o=>({resource:o.resourceType,amount:o.remainingAmount,price:o.price}));
    if (roomOrders.length>0) { pos.marketOrders=10; score+=10; }

    const hwDeposits  =['metal','biomass','silicon','mist'];
    const compressed  =['utrium_bar','lemergium_bar','zynthium_bar','keanium_bar','ghodium_melt','oxidant','reductant','purifier','battery'];
    const regional    =['wire','cell','alloy','condensate'];
    const levelCommod =['composite','crystal','liquid','switch','phlegm','tube','concentrate','transistor','tissue','fixtures','extract','microchip','muscle','frame','spirit','circuit','organoid','hydraulics','emanation','device','organism','machine','essence'];
    const labProds    =['OH','ZK','UL','UH','UO','KH','KO','LH','LO','ZH','ZO','GH','GO','UH2O','UHO2','KH2O','KHO2','LH2O','LHO2','ZH2O','ZHO2','GH2O','GHO2','XUH2O','XUHO2','XKH2O','XKHO2','XLH2O','XLHO2','XZH2O','XZHO2','XGH2O','XGHO2'];
    const chk=(list,key,pts)=>{ const has=list.some(r=>allRes.has(r)); det[key]=has; if(has){pos[key]=pts;score+=pts;} };
    chk(hwDeposits,'hasHighwayDeposits',7); chk(compressed,'hasCompressedCommodities',7);
    chk(regional,'hasRegionalCommodities',7); chk(levelCommod,'hasLevelCommodities',7); chk(labProds,'hasLabProducts',6);

    if (effCache) {
        const t=effCache.totals, obs=Math.max(1,t.ticksObserved);
        if (t.hasLabs && t.labCount>0) {
            const labUtil=t.labReactions/obs/t.labCount;
            const labScore=Math.min(1,labUtil/0.80)*8;
            if (labScore>0) { pos.labUtilization=r1(labScore); score+=labScore; }
            det.labUtilRate=r1(labUtil*100)+'%';
        } else { det.labUtilRate='0% (no labs)'; }
        det.labReactions=t.labReactions;
        if (t.hasTerminal) {
            const sendRate=t.terminalSends/obs;
            const termScore=Math.min(1,sendRate/0.05)*5;
            if (termScore>0) { pos.terminalSendRate=r1(termScore); score+=termScore; }
            det.terminalSendRate=r3(sendRate)+'/tick'; det.terminalFlux=Math.round(t.terminalFlux);
        } else { det.terminalSendRate='0 (no terminal)'; det.terminalFlux=0; }
        det.terminalSends=t.terminalSends;
        if (t.hasFactory) { const facScore=Math.min(5,t.factoryProduces); if (facScore>0){pos.factoryUtilization=facScore;score+=facScore;} }
        det.factoryProduces=t.factoryProduces;
    } else {
        det.labUtilRate='n/a'; det.labReactions=0; det.terminalSendRate='n/a';
        det.terminalFlux=0; det.terminalSends=0; det.factoryProduces=0;
    }

    if (storage&&storage.store) {
        const fill=storage.store.getUsedCapacity()/storage.store.getCapacity()*100;
        det.storageFillPercent=Math.round(fill);
        if (fill>90) { neg.storageNearlyFull=-10; score-=10; }
    }
    const dropped=room.find(FIND_DROPPED_RESOURCES,{filter:r=>r.resourceType===RESOURCE_ENERGY}).reduce((s,r)=>s+r.amount,0);
    det.droppedEnergy=dropped;
    if (dropped>1000) { neg.energyDecaying=-10; score-=10; }
    if (links.length>0 && links.every(l=>l.store[RESOURCE_ENERGY]===0)) { neg.linksEmpty=-8; score-=8; det.allLinksEmpty=true; } else { det.allLinksEmpty=false; }

    let srcInfra=0;
    for (const src of sources)
        if (src.pos.findInRange(links,3).length>0 || src.pos.findInRange(containers,3).length>0) srcInfra++;
    det.sourcesWithInfrastructure=srcInfra; det.totalSources=sources.length;
    if (sources.length>0 && srcInfra<sources.length) { neg.missingSourceInfrastructure=-12; score-=12; }

    return { score, positives:pos, negatives:neg, details:det };
}

// ════════════════════════════════════════════════════════════════════════════
// MILITARY  (25%)
// ════════════════════════════════════════════════════════════════════════════

function analyzeMilitary(room) {
    let score=0;
    const pos={},neg={},det={};
    const towers   =room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_TOWER});
    const nuker    =room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_NUKER})[0];
    const ramparts =room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_RAMPART});
    const walls    =room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_WALL});
    const spawns   =room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_SPAWN});
    const storage  =room.storage;
    const terminal =room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_TERMINAL})[0];
    const labs     =room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_LAB});
    const allDef   =ramparts.concat(walls);
    const allCreeps=room.find(FIND_CREEPS);
    const isRamped =(obj)=>!!ramparts.find(r=>r.pos.isEqualTo(obj.pos)&&r.hits>=10000000);

    if (towers.length>0) { const ts=Math.min(towers.length/6,1)*21; pos.towerCount=r1(ts); score+=ts; }
    det.towerCount=towers.length;
    if (towers.some(t=>isRamped(t))) { pos.towerProtected=1; score+=1; }
    det.towerProtected=towers.some(t=>isRamped(t));

    if (nuker) {
        pos.nukerExists=3; score+=3; det.nukerExists=true;
        const nE=nuker.store[RESOURCE_ENERGY]||0, nG=nuker.store[RESOURCE_GHODIUM]||0;
        const full=nE>=nuker.store.getCapacity(RESOURCE_ENERGY)&&nG>=nuker.store.getCapacity(RESOURCE_GHODIUM);
        if (full){pos.nukerReady=6;score+=6;}
        det.nukerReady=full; det.nukerCharging=!full&&(nE>0||nG>0); det.nukerEnergy=nE; det.nukerGhodium=nG;
        if (isRamped(nuker)){pos.nukerProtected=1;score+=1;} det.nukerProtected=isRamped(nuker);
    } else { det.nukerExists=false; det.nukerProtected=false; }

    if (allDef.length>0) {
        const avg=allDef.reduce((s,d)=>s+d.hits,0)/allDef.length;
        const ds=Math.min(avg/300000000,1)*15;
        pos.avgDefenseStrength=r1(ds); score+=ds;
        det.avgDefenseHits=Math.round(avg); det.minDefenseHits=Math.min(...allDef.map(d=>d.hits)); det.maxDefenseHits=Math.max(...allDef.map(d=>d.hits));
    }
    det.rampartCount=ramparts.length; det.wallCount=walls.length;

    const spawnProt=spawns.some(s=>isRamped(s)), storageProt=storage&&isRamped(storage), termProt=terminal&&isRamped(terminal);
    if (spawnProt)   {pos.spawnProtected=6;score+=6;}
    if (storageProt) {pos.storageProtected=5;score+=5;}
    if (termProt)    {pos.terminalProtected=5;score+=5;}
    det.spawnProtected=spawnProt; det.storageProtected=!!storageProt; det.terminalProtected=!!termProt;

    if (storage&&storage.store) {
        const se=storage.store[RESOURCE_ENERGY]||0;
        pos.storageEnergy=r1(Math.min(se/1000000,1)*6); score+=Math.min(se/1000000,1)*6; det.storageEnergy=se;
    }
    const boosted=allCreeps.filter(c=>c.body.some(p=>p.boost));
    if (boosted.length>0){pos.boostedCreeps=5;score+=5;} det.boostedCreepCount=boosted.length;

    let totalBoosts=0;
    const addBoosts=(store)=>{ if(store) for (const b of COMBAT_BOOSTS) totalBoosts+=store[b]||0; };
    addBoosts(storage&&storage.store); addBoosts(terminal&&terminal.store);
    for (const lab of labs) { if(lab.mineralType&&COMBAT_BOOSTS.includes(lab.mineralType)) totalBoosts+=lab.store[lab.mineralType]||0; }
    if (totalBoosts>0) { const bs=Math.min(totalBoosts/30000,1)*15; pos.combatBoostStockpile=r1(bs); score+=bs; }
    det.combatBoostTotal=totalBoosts;

    if (room.controller&&room.controller.sign) {
        const own=room.controller.owner?room.controller.owner.username:null;
        const sig=room.controller.sign.username;
        det.signByOwner=sig&&own&&sig===own; det.signText=room.controller.sign.text;
        if (det.signByOwner){pos.ownerSign=2;score+=2;} else det.signOwner=sig;
    } else { det.signByOwner=false; }

    if (room.controller&&room.controller.safeModeAvailable>0){pos.safeModeAvailable=4;score+=4;}
    if (room.controller&&!room.controller.safeModeCooldown)   {pos.safeModeReady=5;score+=5;}
    det.safeModeAvailable=room.controller?room.controller.safeModeAvailable:0;
    det.safeModeCooldown =room.controller?room.controller.safeModeCooldown:0;
    det.safeModeActive   =room.controller?room.controller.safeMode:0;

    const emptyTowers=towers.filter(t=>t.store[RESOURCE_ENERGY]===0);
    if (emptyTowers.length>0){neg.towersEmpty=-15;score-=15;}
    const lowTowers=towers.filter(t=>t.store[RESOURCE_ENERGY]/t.store.getCapacity(RESOURCE_ENERGY)<0.25&&t.store[RESOURCE_ENERGY]>0);
    if (lowTowers.length>0){neg.towersLowEnergy=-10;score-=10;}
    det.emptyTowerCount=emptyTowers.length; det.lowEnergyTowerCount=lowTowers.length;

    const weakRamps=ramparts.filter(r=>r.hits<100000);
    if (weakRamps.length>0){neg.weakRamparts=-12;score-=12;}
    det.weakRampartCount=weakRamps.length; det.totalDefenseCount=allDef.length;

    if (room.controller&&room.controller.level>=2) {
        if      (walls.length===0&&ramparts.length===0){neg.noDefenses=-50;score-=50;}
        else if (walls.length>0&&ramparts.length===0)  {neg.noRamparts=-25;score-=25;}
    }

    if (storage&&allDef.length>0) {
        const breached=checkWallEffectiveness(room,storage,ramparts,walls);
        det.wallsEffective=breached.length===0; det.breachedEntrances=breached.length; det.breachedDirections=breached;
        if (breached.length>0){neg.wallsBreached=-15;score-=15;}
    } else { det.wallsEffective=false; det.breachedEntrances=0; det.breachedDirections=[]; }

    const sources=room.find(FIND_SOURCES);
    if (room.controller&&allDef.length>0) {
        det.controllerExposed=checkPathToTarget(room,room.controller,ramparts,walls);
        if (det.controllerExposed){neg.controllerExposed=-10;score-=10;}
    } else { det.controllerExposed=true; }

    let exposedSrc=0;
    if (sources.length>0&&allDef.length>0) { for (const src of sources) if(checkPathToTarget(room,src,ramparts,walls)) exposedSrc++; }
    else exposedSrc=sources.length;
    det.exposedSourceCount=exposedSrc; det.totalSourceCount=sources.length;
    if (exposedSrc>0){neg.sourcesExposed=-10;score-=10;}

    return { score, positives:pos, negatives:neg, details:det };
}

// ════════════════════════════════════════════════════════════════════════════
// DUAL PURPOSE  (30%)
// ════════════════════════════════════════════════════════════════════════════

function analyzeDualPurpose(room) {
    let score=0;
    const pos={},neg={},det={};
    const rcl=room.controller?room.controller.level:0;
    const spawns    =room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_SPAWN});
    const extensions=room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_EXTENSION});
    const powerSpawn=room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_POWER_SPAWN})[0];
    const terminal  =room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_TERMINAL})[0];
    const storage   =room.storage;
    const observer  =room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_OBSERVER})[0];
    const allCreeps =room.find(FIND_CREEPS);
    const myCreeps  =room.find(FIND_MY_CREEPS);
    const powerCreeps=room.find(FIND_POWER_CREEPS);

    if (rcl>0){const rs=(rcl/8)*17;pos.rcl=r1(rs);score+=rs;} det.rcl=rcl;
    if (spawns.length>0){const ss=Math.min(spawns.length/3,1)*14;pos.spawnCount=r1(ss);score+=ss;}
    det.spawnCount=spawns.length; det.maxSpawns=SPAWNS_BY_RCL[rcl]||0;

    const expExt=EXTENSIONS_BY_RCL[rcl]||0;
    if (expExt>0&&extensions.length>=expExt){pos.maxExtensions=10;score+=10;}
    else if (extensions.length>0&&expExt>0){const es=(extensions.length/expExt)*10;pos.extensionProgress=r1(es);score+=es;}
    det.extensionCount=extensions.length; det.expectedExtensions=expExt;

    if (powerSpawn){
        pos.powerSpawnExists=6;score+=6;det.powerSpawnExists=true;
        if(powerSpawn.store[RESOURCE_ENERGY]>0){pos.powerSpawnFueled=3;score+=3;}
        det.powerSpawnEnergy=powerSpawn.store[RESOURCE_ENERGY]; det.powerSpawnPower=powerSpawn.store[RESOURCE_POWER];
    } else { det.powerSpawnExists=false; }

    let pwr=0;
    if(storage)    pwr+=storage.store[RESOURCE_POWER]||0;
    if(terminal)   pwr+=terminal.store[RESOURCE_POWER]||0;
    if(powerSpawn) pwr+=powerSpawn.store[RESOURCE_POWER]||0;
    if(pwr>0){pos.powerInRoom=1;score+=1;} det.powerInRoom=pwr;

    if (terminal){
        pos.terminalExists=8;score+=8;det.terminalExists=true;
        const te=terminal.store[RESOURCE_ENERGY]||0;
        if(te>=1000){pos.terminalHasEnergy=3;score+=3;} det.terminalEnergy=te;
        const tRes=Object.keys(terminal.store).filter(r=>r!==RESOURCE_ENERGY&&terminal.store[r]>0);
        if(tRes.length>0){pos.terminalHasResources=5;score+=5;} det.terminalResourceCount=tRes.length;
    } else { det.terminalExists=false;det.terminalEnergy=0;det.terminalResourceCount=0; }

    if(storage){pos.storageExists=8;score+=8;det.storageExists=true;det.storageTotalUsed=storage.store.getUsedCapacity();}
    else{det.storageExists=false;det.storageTotalUsed=0;}

    const large=allCreeps.filter(c=>c.body.length>=30);
    if(large.length>0){pos.largeCreeps=8;score+=8;}
    det.largeCreepCount=large.length; det.maxCreepSize=allCreeps.length>0?Math.max(...allCreeps.map(c=>c.body.length)):0;

    if(powerCreeps.length>0){pos.powerCreeps=6;score+=6;} det.powerCreepCount=powerCreeps.length;
    if(observer){pos.observer=6;score+=6;} det.observerExists=!!observer;

    const haulers=allCreeps.filter(c=>c.body.length>=30&&c.body.every(p=>p.type===MOVE||p.type===CARRY));
    if(haulers.length>0){pos.hasHauler=5;score+=5;}
    det.haulerCount=haulers.length;det.myCreepCount=myCreeps.length;det.totalCreepCount=allCreeps.length;
    det.downgradeTimer=room.controller?room.controller.ticksToDowngrade:0;

    if(room.controller&&room.controller.ticksToDowngrade){
        if(room.controller.ticksToDowngrade<50000){neg.lowDowngradeTimer=-15;score-=15;}
        else if(room.controller.ticksToDowngrade<100000){neg.mediumDowngradeTimer=-8;score-=8;}
    }

    det.extensionEnergyPercent=100;
    if(extensions.length>0){
        const totE=extensions.reduce((s,e)=>s+e.store[RESOURCE_ENERGY],0);
        const totC=extensions.reduce((s,e)=>s+e.store.getCapacity(RESOURCE_ENERGY),0);
        const pct=totC>0?(totE/totC)*100:0;
        det.extensionEnergyPercent=Math.round(pct);
        if(totE===0){neg.extensionsEmpty=-12;score-=12;}
        else if(pct<25){neg.extensionsCritical=-8;score-=8;}
        else if(pct<50){neg.extensionsLow=-5;score-=5;}
    }

    const expSpawns=SPAWNS_BY_RCL[rcl]||0;
    if(spawns.length<expSpawns){neg.missingSpawns=-12;score-=12;}
    if(extensions.length<expExt&&expExt>0){neg.missingExtensions=-10;score-=10;}
    det.missingSpawns=Math.max(0,expSpawns-spawns.length); det.missingExtensions=Math.max(0,expExt-extensions.length);

    if(storage&&storage.store.getUsedCapacity()<10000){neg.storageEmpty=-10;score-=10;}
    if(rcl>=4&&!storage){neg.noStorage=-15;score-=15;}

    return { score, positives:pos, negatives:neg, details:det };
}

// ════════════════════════════════════════════════════════════════════════════
// WALL EFFECTIVENESS
// ════════════════════════════════════════════════════════════════════════════

function checkWallEffectiveness(room, storage, ramparts, walls) {
    const terrain=room.getTerrain(), dirs={top:[],bottom:[],left:[],right:[]};
    for (let i=1;i<49;i+=5){
        if(terrain.get(i,0)!==TERRAIN_MASK_WALL)  dirs.top.push(new RoomPosition(i,0,room.name));
        if(terrain.get(i,49)!==TERRAIN_MASK_WALL) dirs.bottom.push(new RoomPosition(i,49,room.name));
        if(terrain.get(0,i)!==TERRAIN_MASK_WALL)  dirs.left.push(new RoomPosition(0,i,room.name));
        if(terrain.get(49,i)!==TERRAIN_MASK_WALL) dirs.right.push(new RoomPosition(49,i,room.name));
    }
    const costFn=(rn)=>{ if(rn!==room.name) return false; const m=new PathFinder.CostMatrix(); for(const s of ramparts.concat(walls)) m.set(s.pos.x,s.pos.y,255); return m; };
    const breached=[];
    for (const dir in dirs) {
        for (const entry of dirs[dir]) {
            const r=PathFinder.search(entry,{pos:storage.pos,range:1},{plainCost:1,swampCost:5,roomCallback:costFn,maxRooms:1});
            if(!r.incomplete&&r.path.length>0){breached.push(dir);break;}
        }
    }
    return breached;
}

function checkPathToTarget(room, target, ramparts, walls) {
    const terrain=room.getTerrain(), entries=[];
    for (let i=1;i<49;i+=5){
        if(terrain.get(i,0)!==TERRAIN_MASK_WALL)  entries.push(new RoomPosition(i,0,room.name));
        if(terrain.get(i,49)!==TERRAIN_MASK_WALL) entries.push(new RoomPosition(i,49,room.name));
        if(terrain.get(0,i)!==TERRAIN_MASK_WALL)  entries.push(new RoomPosition(0,i,room.name));
        if(terrain.get(49,i)!==TERRAIN_MASK_WALL) entries.push(new RoomPosition(49,i,room.name));
    }
    const costFn=(rn)=>{ if(rn!==room.name) return false; const m=new PathFinder.CostMatrix(); for(const s of ramparts.concat(walls)) m.set(s.pos.x,s.pos.y,255); return m; };
    for (const entry of entries) {
        const r=PathFinder.search(entry,{pos:target.pos,range:1},{plainCost:1,swampCost:5,roomCallback:costFn,maxRooms:1});
        if(!r.incomplete&&r.path.length>0) return true;
    }
    return false;
}

// ════════════════════════════════════════════════════════════════════════════
// OBSERVER HELPERS
// ════════════════════════════════════════════════════════════════════════════

function parseRoomCoords(name) {
    const m=name.match(/^([WE])(\d+)([NS])(\d+)$/);
    if(!m) return null;
    let x=parseInt(m[2]),y=parseInt(m[4]);
    if(m[1]==='W') x=-x-1;
    if(m[3]==='S') y=-y-1;
    return {x,y};
}

function findObserversInRange(targetRoom) {
    const tc=parseRoomCoords(targetRoom);
    if(!tc) return [];
    const results=[];
    for (const rn in Game.rooms) {
        const room=Game.rooms[rn];
        if(!room.controller||!room.controller.my) continue;
        for (const obs of room.find(FIND_STRUCTURES,{filter:s=>s.structureType===STRUCTURE_OBSERVER})) {
            const oc=parseRoomCoords(rn);
            if(!oc) continue;
            const dist=Math.max(Math.abs(tc.x-oc.x),Math.abs(tc.y-oc.y));
            if(dist<=OBSERVER_RANGE) results.push({obs,dist});
        }
    }
    results.sort((a,b)=>a.dist-b.dist);
    return results.map(r=>r.obs);
}

function findBestObserver(target) { const list=findObserversInRange(target); return list.length?list[0]:null; }
function isOwnRoom(roomName)      { const r=Game.rooms[roomName]; return !!(r&&r.controller&&r.controller.my); }

// ════════════════════════════════════════════════════════════════════════════
// PRINT REPORT
// ════════════════════════════════════════════════════════════════════════════

function printReport(res) {
    const DIV='════════════════════════════════════════════════════════════════════════════════';
    const L=[];
    L.push(DIV);
    L.push('ROOM INTEL: '+res.room+' | Owner: '+res.owner+' | RCL: '+res.rcl+' | '+scoreRating(res.overall)+' | OVERALL: '+res.overall+'/100 | TOTAL VALUE: '+fmtCredits(res.totalValue)+' | Purpose: '+res.purpose);
    L.push(DIV);

    L.push('📊 ECONOMIC [20%]: '+res.economic.score+'/100 | VALUE: '+fmtCredits(res.economic.value.total)+' (structs: '+fmtCredits(res.economic.value.structureCredits)+' | res: '+fmtCredits(res.economic.value.resourceCredits)+')');
    L.push('   '+fmtPosNeg(res.economic.positives,res.economic.negatives));
    const ed=res.economic.details;
    L.push('   Factory: Lvl '+(ed.factoryLevel||0)+' | Extractor: '+(ed.extractorExists?(ed.extractorActive?'Active':'Idle'):'None')+' | Mineral: '+(ed.mineralType||'N/A')+' | Labs: '+ed.labCount+'/10 ('+ed.activeLabCount+' active) | Links: '+ed.linkCount+'/4');
    L.push('   Diversity: '+ed.storageDiversityCount+'/25 | Storage: '+(ed.storageFillPercent||0)+'% full | Dropped E: '+ed.droppedEnergy+' | Market: '+(ed.marketTotalOrders||0)+' orders ('+(ed.marketBuyOrders||0)+'B/'+(ed.marketSellOrders||0)+'S)');
    if(ed.sellOrderDetails&&ed.sellOrderDetails.length) L.push('   Selling: '+ed.sellOrderDetails.map(o=>o.resource+' ×'+fmtNum(o.amount)+' @'+o.price).join(', '));
    if(ed.buyOrderDetails&&ed.buyOrderDetails.length)   L.push('   Buying:  '+ed.buyOrderDetails.map(o=>o.resource+' ×'+fmtNum(o.amount)+' @'+o.price).join(', '));
    L.push('   Commodities → Highway:'+yn(ed.hasHighwayDeposits)+' Compressed:'+yn(ed.hasCompressedCommodities)+' Regional:'+yn(ed.hasRegionalCommodities)+' Lvl1-5:'+yn(ed.hasLevelCommodities)+' LabProd:'+yn(ed.hasLabProducts));
    L.push('   Production → Labs: '+ed.labUtilRate+' ('+(ed.labReactions||0)+' rxns) | Terminal: '+ed.terminalSendRate+' ('+(ed.terminalSends||0)+' sends, flux:'+fmtNum(ed.terminalFlux||0)+') | Factory: '+(ed.factoryProduces||0)+' produces');

    L.push('⚔️  MILITARY [25%]: '+res.military.score+'/100 | VALUE: '+fmtCredits(res.military.value.total)+' (structs: '+fmtCredits(res.military.value.structureCredits)+' | boosts: '+fmtCredits(res.military.value.resourceCredits)+')');
    L.push('   '+fmtPosNeg(res.military.positives,res.military.negatives));
    const md=res.military.details;
    L.push('   Towers: '+md.towerCount+'/6 (empty:'+md.emptyTowerCount+' low:'+md.lowEnergyTowerCount+') | Nuker: '+(()=>{if(!md.nukerExists)return'None';if(md.nukerReady)return'READY';if(md.nukerCharging)return'Charging ('+fmtNum(md.nukerEnergy)+'E/'+fmtNum(md.nukerGhodium)+'G)';return'Empty';})()+' | SafeMode: '+md.safeModeAvailable+' avail');
    L.push('   Walls: '+md.wallCount+' | Ramparts: '+md.rampartCount+' (weak<100k: '+md.weakRampartCount+') | Def avg: '+fmtNum(md.avgDefenseHits)+' min: '+fmtNum(md.minDefenseHits));
    L.push('   Protected (10M+ ramp) → Spawn:'+yn(md.spawnProtected)+' Storage:'+yn(md.storageProtected)+' Terminal:'+yn(md.terminalProtected)+' Tower:'+yn(md.towerProtected)+' Nuker:'+yn(md.nukerProtected));
    L.push('   Boosted creeps: '+md.boostedCreepCount+' | Combat boosts: '+fmtNum(md.combatBoostTotal)+'/30k | Signed by owner: '+yn(md.signByOwner));
    L.push('   Walls: '+(()=>{if(!md.totalDefenseCount)return'no defenses';return md.wallsEffective?'✓ Effective':'✗ BREACHED: '+md.breachedDirections.join(', ');})()+' | Exposed → Ctrl:'+yn(md.controllerExposed)+' Sources: '+md.exposedSourceCount+'/'+md.totalSourceCount);

    L.push('🔧 DUAL PURPOSE [30%]: '+res.dualPurpose.score+'/100 | VALUE: '+fmtCredits(res.dualPurpose.value.total)+' (structs: '+fmtCredits(res.dualPurpose.value.structureCredits)+' | liquid: '+fmtCredits(res.dualPurpose.value.resourceCredits)+')');
    L.push('   '+fmtPosNeg(res.dualPurpose.positives,res.dualPurpose.negatives));
    const dd=res.dualPurpose.details;
    L.push('   Spawns: '+dd.spawnCount+'/'+dd.maxSpawns+' | Extensions: '+dd.extensionCount+'/'+dd.expectedExtensions+' ('+(dd.extensionEnergyPercent||0)+'% E) | Downgrade: '+(dd.downgradeTimer<100000?fmtNum(dd.downgradeTimer)+' ⚠️':'OK'));
    L.push('   Storage: '+fmtNum(dd.storageTotalUsed)+' used | Terminal: '+fmtNum(dd.terminalEnergy)+'E, '+dd.terminalResourceCount+' types | Power: '+fmtNum(dd.powerInRoom));
    L.push('   PwrSpawn: '+(dd.powerSpawnExists?dd.powerSpawnEnergy+'E/'+dd.powerSpawnPower+'P':'None')+' | Observer: '+yn(dd.observerExists)+' | Creeps: '+dd.myCreepCount+' | Haulers: '+dd.haulerCount+' | PowerCreeps: '+dd.powerCreepCount);

    L.push('⚙️  OPERATIONAL EFFICIENCY [25%]: '+res.operational.score+'/100');
    L.push('   '+fmtPosNeg(res.operational.positives,res.operational.negatives));
    const od=res.operational.details;
    L.push('   Observed: '+od.ticksObserved+' ticks ('+od.invisibleTicks+' invisible)');
    L.push('   Energy → Income: '+od.incomePerTick+'/'+od.maxIncomePerTick+' E/tick | Capture: '+od.energyCaptureRate);
    L.push('   Source max rates: '+od.sourceMaxRates);
    L.push('   Source fractions: '+od.sourceFractions);
    L.push('   Spend → Upkeep: '+od.maintPerTick+' | Spawn: '+od.spawnPerTick+' | Upgrade: '+od.upgradePerTick+' | Towers: '+od.towerCostPerTick);
    L.push('   Repair → Creep: '+od.creepRepairShare+' | Tower actions: '+od.towerRepairActions+' | Total events: '+od.totalRepairEvents);
    L.push('   Movement → '+od.movesPerCreepTick+' moves/creep/tick | Total: '+od.totalCreepMoves+' | Avg creeps: '+od.avgCreeps);
    const _pct=(n)=>od.totalIntents>0?r1(n/od.totalIntents*100)+'%':'0%';
    L.push('   Intents → Productive: '+od.productiveRatio+' ('+od.productiveIntents+'/'+od.totalIntents+') | Move: '+_pct(od.totalCreepMoves)+' ('+od.totalCreepMoves+') | Harvest: '+_pct(od.ev_harvest)+' ('+od.ev_harvest+') | Repair: '+_pct(od.ev_repairAny)+' ('+od.ev_repairAny+') | Transfer: '+_pct(od.ev_transfer)+' ('+od.ev_transfer+') | Build: '+_pct(od.ev_build)+' ('+od.ev_build+') | Upgrade: '+_pct(od.ev_upgradeController)+' ('+od.ev_upgradeController+') | Attack: '+_pct(od.ev_attack)+' ('+od.ev_attack+') | Heal: '+_pct(od.ev_heal)+' ('+od.ev_heal+') | Power: '+_pct(od.ev_power)+' ('+od.ev_power+')');
    L.push('   CPU/creep: '+od.cpuPerCreep+' ('+od.cpuTotalMid+' total mid over window)');

    for (const line of buildTerminalFlowLines(
        {terminalIn:od.terminalIn, terminalOut:od.terminalOut, hasTerminal:od.hasTerminal, ticksObserved:od.ticksObserved},
        '   '
    )) L.push(line);

    L.push(DIV);
    L.push('SUMMARY: '+buildSummary(res));
    L.push(DIV);
    console.log(L.join('\n'));
}

// ════════════════════════════════════════════════════════════════════════════
// PRINT FAST REPORT
// ════════════════════════════════════════════════════════════════════════════

function printFastReport(res) {
    const DIV='════════════════════════════════════════════════════════════════════════════════';
    const L=[];
    L.push(DIV);
    L.push('ROOM INTEL (FAST): '+res.room+' | Owner: '+res.owner+' | RCL: '+res.rcl+' | '+scoreRating(res.overall)+' | OVERALL: '+res.overall+'/100 | TOTAL VALUE: '+fmtCredits(res.totalValue)+'  [Eco·Mil·DP only — no Operational]');
    L.push(DIV);

    L.push('📊 ECONOMIC [27%]: '+res.economic.score+'/100 | VALUE: '+fmtCredits(res.economic.value.total)+' (structs: '+fmtCredits(res.economic.value.structureCredits)+' | res: '+fmtCredits(res.economic.value.resourceCredits)+')');
    L.push('   '+fmtPosNeg(res.economic.positives,res.economic.negatives));
    const ed=res.economic.details;
    L.push('   Factory: Lvl '+(ed.factoryLevel||0)+' | Extractor: '+(ed.extractorExists?(ed.extractorActive?'Active':'Idle'):'None')+' | Mineral: '+(ed.mineralType||'N/A')+' | Labs: '+ed.labCount+'/10 ('+ed.activeLabCount+' active) | Links: '+ed.linkCount+'/4');
    L.push('   Diversity: '+ed.storageDiversityCount+'/25 | Storage: '+(ed.storageFillPercent||0)+'% full | Dropped E: '+ed.droppedEnergy+' | Market: '+(ed.marketTotalOrders||0)+' orders ('+(ed.marketBuyOrders||0)+'B/'+(ed.marketSellOrders||0)+'S)');
    if(ed.sellOrderDetails&&ed.sellOrderDetails.length) L.push('   Selling: '+ed.sellOrderDetails.map(o=>o.resource+' ×'+fmtNum(o.amount)+' @'+o.price).join(', '));
    if(ed.buyOrderDetails&&ed.buyOrderDetails.length)   L.push('   Buying:  '+ed.buyOrderDetails.map(o=>o.resource+' ×'+fmtNum(o.amount)+' @'+o.price).join(', '));
    L.push('   Commodities → Highway:'+yn(ed.hasHighwayDeposits)+' Compressed:'+yn(ed.hasCompressedCommodities)+' Regional:'+yn(ed.hasRegionalCommodities)+' Lvl1-5:'+yn(ed.hasLevelCommodities)+' LabProd:'+yn(ed.hasLabProducts));
    L.push('   Production rates unavailable — run intel(\''+res.room+'\') for the full profile.');

    L.push('⚔️  MILITARY [33%]: '+res.military.score+'/100 | VALUE: '+fmtCredits(res.military.value.total)+' (structs: '+fmtCredits(res.military.value.structureCredits)+' | boosts: '+fmtCredits(res.military.value.resourceCredits)+')');
    L.push('   '+fmtPosNeg(res.military.positives,res.military.negatives));
    const md=res.military.details;
    L.push('   Towers: '+md.towerCount+'/6 (empty:'+md.emptyTowerCount+' low:'+md.lowEnergyTowerCount+') | Nuker: '+(()=>{if(!md.nukerExists)return'None';if(md.nukerReady)return'READY';if(md.nukerCharging)return'Charging ('+fmtNum(md.nukerEnergy)+'E/'+fmtNum(md.nukerGhodium)+'G)';return'Empty';})()+' | SafeMode: '+md.safeModeAvailable+' avail');
    L.push('   Walls: '+md.wallCount+' | Ramparts: '+md.rampartCount+' (weak<100k: '+md.weakRampartCount+') | Def avg: '+fmtNum(md.avgDefenseHits)+' min: '+fmtNum(md.minDefenseHits));
    L.push('   Protected (10M+ ramp) → Spawn:'+yn(md.spawnProtected)+' Storage:'+yn(md.storageProtected)+' Terminal:'+yn(md.terminalProtected)+' Tower:'+yn(md.towerProtected)+' Nuker:'+yn(md.nukerProtected));
    L.push('   Boosted creeps: '+md.boostedCreepCount+' | Combat boosts: '+fmtNum(md.combatBoostTotal)+'/30k | Signed by owner: '+yn(md.signByOwner));
    L.push('   Walls: '+(()=>{if(!md.totalDefenseCount)return'no defenses';return md.wallsEffective?'✓ Effective':'✗ BREACHED: '+md.breachedDirections.join(', ');})()+' | Exposed → Ctrl:'+yn(md.controllerExposed)+' Sources: '+md.exposedSourceCount+'/'+md.totalSourceCount);

    L.push('🔧 DUAL PURPOSE [40%]: '+res.dualPurpose.score+'/100 | VALUE: '+fmtCredits(res.dualPurpose.value.total)+' (structs: '+fmtCredits(res.dualPurpose.value.structureCredits)+' | liquid: '+fmtCredits(res.dualPurpose.value.resourceCredits)+')');
    L.push('   '+fmtPosNeg(res.dualPurpose.positives,res.dualPurpose.negatives));
    const dd=res.dualPurpose.details;
    L.push('   Spawns: '+dd.spawnCount+'/'+dd.maxSpawns+' | Extensions: '+dd.extensionCount+'/'+dd.expectedExtensions+' ('+(dd.extensionEnergyPercent||0)+'% E) | Downgrade: '+(dd.downgradeTimer<100000?fmtNum(dd.downgradeTimer)+' ⚠️':'OK'));
    L.push('   Storage: '+fmtNum(dd.storageTotalUsed)+' used | Terminal: '+fmtNum(dd.terminalEnergy)+'E, '+dd.terminalResourceCount+' types | Power: '+fmtNum(dd.powerInRoom));
    L.push('   PwrSpawn: '+(dd.powerSpawnExists?dd.powerSpawnEnergy+'E/'+dd.powerSpawnPower+'P':'None')+' | Observer: '+yn(dd.observerExists)+' | Creeps: '+dd.myCreepCount+' | Haulers: '+dd.haulerCount+' | PowerCreeps: '+dd.powerCreepCount);
    L.push('⚙️  OPERATIONAL EFFICIENCY [--]: not measured  ← call intel(\''+res.room+'\') to start the 100-tick profile');

    L.push(DIV);
    L.push('SUMMARY (fast): '+buildFastSummary(res));
    L.push(DIV);
    console.log(L.join('\n'));
}

// ════════════════════════════════════════════════════════════════════════════
// CACHE MANAGEMENT
// ════════════════════════════════════════════════════════════════════════════

function cleanExpiredIntel() {
    if (Memory[EFF_CACHE_KEY]) {
        for (const rn in Memory[EFF_CACHE_KEY])
            if ((Memory[EFF_CACHE_KEY][rn].expiresTick||0)<=Game.time) delete Memory[EFF_CACHE_KEY][rn];
    }
    if (Memory.roomIntelPending)
        for (const rn in Memory.roomIntelPending)
            if (Game.time-Memory.roomIntelPending[rn].tick>5) delete Memory.roomIntelPending[rn];
    if (Memory.intelPowerObserve)
        for (const rn in Memory.intelPowerObserve)
            if (Game.time-Memory.intelPowerObserve[rn].tick>50) delete Memory.intelPowerObserve[rn];
}

function processPendingIntel() {
    if (!Memory.roomIntelPending) return;
    for (const rn in Memory.roomIntelPending) {
        const p=Memory.roomIntelPending[rn];
        if (Game.time-p.tick===1 && Game.rooms[rn]) {
            if (p.fast) { console.log('[IntelFast] 🔭 Auto-completing fast intel for '+rn); intelFast(rn); }
            else         { console.log('[Intel] 🔭 Auto-completing intel for '+rn);     intel(rn);     }
        }
    }
}

function getCachedIntel(roomName) { return null; }

function listIntel() {
    const cache=Memory[EFF_CACHE_KEY], active=Memory[EFF_MEM_KEY];
    const hasCache=cache&&Object.keys(cache).length>0, hasActive=active&&Object.keys(active).length>0;
    if (!hasCache&&!hasActive) { console.log('[Intel] No efficiency profiles cached or active.'); return; }
    console.log('\n=== EFFICIENCY PROFILES ===');
    if (hasActive) for (const rn in active) { const p=active[rn]; console.log('  '+rn+': profiling '+p.totals.ticksObserved+'/'+PROFILE_TICKS+' ticks'); }
    if (hasCache)  for (const rn in cache)  { const c=cache[rn],exp=c.expiresTick-Game.time,cpu=calcEffCPU(c.totals); console.log('  '+rn+': complete | CPU/creep: '+(cpu.cpuPerCreep!==null?r3(cpu.cpuPerCreep):'n/a')+' | expires in '+exp+'t'); }
    console.log('===========================\n');
}

// ════════════════════════════════════════════════════════════════════════════
// FORMAT HELPERS
// ════════════════════════════════════════════════════════════════════════════

function clamp(n) { return Math.max(0,Math.min(100,n)); }
function r1(n)    { return Math.round(n*10)/10; }
function r2(n)    { return Math.round(n*100)/100; }
function r3(n)    { return Math.round(n*1000)/1000; }
function yn(v)    { return v?'Y':'N'; }

function fmtNum(n) {
    if (n===undefined||n===null) return '0';
    if (n>=1000000) return (n/1000000).toFixed(1)+'M';
    if (n>=1000)    return (n/1000).toFixed(1)+'k';
    return String(Math.round(n));
}

function fmtCredits(n) {
    if (!n) return '0 cr';
    if (n>=1000000) return (n/1000000).toFixed(2)+'M cr';
    if (n>=1000)    return (n/1000).toFixed(1)+'k cr';
    return Math.round(n)+' cr';
}

const KEY_SHORT = {
    factoryExists:'Fac',factoryLeveled:'FacLvl',extractorExists:'Ext',extractorActive:'ExtAct',
    storageDiversity:'Div',linkCount:'Links',labCount:'Labs',labsActive:'LabAct',
    marketOrders:'Market',hasHighwayDeposits:'Highway',hasCompressedCommodities:'Compressed',
    hasRegionalCommodities:'Regional',hasLevelCommodities:'LvlCommod',hasLabProducts:'LabProd',
    labUtilization:'LabUtil',terminalSendRate:'TermSend',factoryUtilization:'FacUtil',
    storageNearlyFull:'StoFull',energyDecaying:'Decay',linksEmpty:'LinkEmpty',missingSourceInfrastructure:'NoSrcInf',
    towerCount:'Twr',towerProtected:'TwrProt',nukerExists:'Nuke',nukerReady:'NukeRdy',
    nukerProtected:'NukeProt',avgDefenseStrength:'DefStr',spawnProtected:'SpwnProt',
    storageProtected:'StoProt',terminalProtected:'TermProt',storageEnergy:'StoE',
    boostedCreeps:'Boost',combatBoostStockpile:'BoostStk',ownerSign:'Sign',
    safeModeAvailable:'SafeAvl',safeModeReady:'SafeRdy',towersEmpty:'TwrEmpty',
    towersLowEnergy:'TwrLow',weakRamparts:'WeakRamp',noDefenses:'NoDef',noRamparts:'NoRamp',
    wallsBreached:'Breached',controllerExposed:'CtrlExp',sourcesExposed:'SrcExp',
    rcl:'RCL',spawnCount:'Spwn',maxExtensions:'MaxExt',extensionProgress:'ExtProg',
    powerSpawnExists:'PSpwn',powerSpawnFueled:'PSpwnE',powerInRoom:'PwrInRoom',
    terminalExists:'Term',terminalHasEnergy:'TermE',terminalHasResources:'TermRes',
    storageExists:'Sto',largeCreeps:'BigCreep',powerCreeps:'PCreep',observer:'Obs',
    hasHauler:'Hauler',lowDowngradeTimer:'LowDg',mediumDowngradeTimer:'MedDg',
    missingSpawns:'NoSpwn',missingExtensions:'NoExt',storageEmpty:'StoEmpty',
    noStorage:'NoSto',extensionsEmpty:'ExtEmpty',extensionsCritical:'ExtCrit',extensionsLow:'ExtLow',
    energyCaptureRate:'Capture',incomeSurplus:'Surplus',cpuEfficiency:'CPU/Creep',
    productiveIntentRatio:'ProdInt',creepRepairShare:'CreepRep',lowMovesPerCreep:'LowMove',
    efficientMovementBonus:'MoveBonus',moderateMovesPerCreep:'ModMove',
    highMovesPerCreep:'HighMove',energyDeficit:'Deficit',highCpuPerCreep:'HighCPU',
    towerRepairDominant:'TwrRep',sustainedBuildActivity:'Building',
    sourceFractions:'SrcFrac'
};

function fmtKey(k)        { return KEY_SHORT[k]||k; }
function fmtPosNeg(pos,neg) {
    const p=Object.keys(pos).map(k=>fmtKey(k)+':+'+pos[k]).join(', ');
    const n=Object.keys(neg).map(k=>fmtKey(k)+':'+neg[k]).join(', ');
    return 'Pos:['+p+']'+(n?' Neg:['+n+']':'');
}

function scoreRating(s) {
    if(s>=90) return '⭐ ELITE';
    if(s>=75) return '🟢 STRONG';
    if(s>=60) return '🟡 DEVELOPED';
    if(s>=45) return '🟠 MODERATE';
    if(s>=30) return '🔴 WEAK';
    if(s>=15) return '⚫ STRUGGLING';
    return '💀 CRITICAL';
}

function buildSummary(res) {
    const parts=[
        res.economic.score>=70?'Strong economy':res.economic.score>=40?'Moderate economy':'Weak economy',
        res.military.score>=70?'well-defended':res.military.score>=40?'some defenses':'poorly defended',
        res.dualPurpose.score>=70?'mature infrastructure':res.dualPurpose.score>=40?'developing infrastructure':'limited infrastructure',
    ];
    if(res.operational) parts.push(res.operational.score>=70?'highly efficient':res.operational.score>=40?'moderate efficiency':'inefficient operation');
    const totalNeg=Object.keys(res.economic.negatives).length+Object.keys(res.military.negatives).length+Object.keys(res.dualPurpose.negatives).length+(res.operational?Object.keys(res.operational.negatives).length:0);
    if(totalNeg>5)      parts.push('MULTIPLE VULNERABILITIES');
    else if(totalNeg>2) parts.push('some vulnerabilities');
    return parts.join(', ');
}

function buildFastSummary(res) {
    const parts=[
        res.economic.score>=70?'Strong economy':res.economic.score>=40?'Moderate economy':'Weak economy',
        res.military.score>=70?'well-defended':res.military.score>=40?'some defenses':'poorly defended',
        res.dualPurpose.score>=70?'mature infrastructure':res.dualPurpose.score>=40?'developing infrastructure':'limited infrastructure',
    ];
    const totalNeg=Object.keys(res.economic.negatives).length+Object.keys(res.military.negatives).length+Object.keys(res.dualPurpose.negatives).length;
    if(totalNeg>5)      parts.push('MULTIPLE VULNERABILITIES');
    else if(totalNeg>2) parts.push('some vulnerabilities');
    return parts.join(', ');
}

// ════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ════════════════════════════════════════════════════════════════════════════

module.exports = {
    intel, intelFast, processEfficiencyProfiles, processPendingIntel,
    cleanExpiredIntel, getCachedIntel, getCachedEff, listIntel, findObserversInRange,
};

global.intel     = intel;
global.intelFast = intelFast;
global.listIntel = listIntel;