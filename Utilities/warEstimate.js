/**
 * warEstimate.js - War outcome estimation against a specific player
 *
 * ═══════════════════════════════════════════════════════════════════
 * CONSOLE COMMANDS:
 * ═══════════════════════════════════════════════════════════════════
 *
 *   warEstimate('PlayerName')       - Run full war estimate
 *   warEstimateStatus()             - Check progress
 *   warEstimateCancel()             - Cancel active estimate
 *   warEstimateLast()               - View last estimate report (2k tick TTL)
 *
 * ═══════════════════════════════════════════════════════════════════
 *
 * PHASES:
 *   1. Discovery - Scan all rooms in observer range for enemy bases
 *                  (SKIPPED if fresh player() data exists)
 *   2. Intel     - Re-observe each enemy room for detailed war data
 *                  Includes full 5×5 nuke sweep (credit damage estimate)
 *   3. Monitor   - 10 snapshots at 1k tick intervals for trend detection
 *   4. Compute   - Score all 6 categories × 3 horizons, generate report
 *   5. Notify    - Send report via Game.notify (split ≤500 char chunks,
 *                  max 10 per tick)
 *
 * CATEGORIES (weights constant across all time horizons):
 *   1. Comparative Force Projection  (20%)
 *   2. Spawn Throughput Estimation   (20%)
 *   3. Attrition & Sustainability    (20%)
 *   4. Boost Production & Stockpile  (15%)
 *   5. Defensive Depth / Turtle      (15%)
 *   6. Multi-Front Strain            (10%)
 *
 * INTEGRATION:
 *   const warEstimate = require('warEstimate');
 *   // In main loop (every tick, no modulo):
 *   warEstimate.run();
 *   // wideScan.run() must also run every tick for discovery phase.
 */

'use strict';

const wideScan = require('wideScan');

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════

const OBSERVER_RANGE     = 10;
const NUKE_RANGE         = 5;
const SUPPORT_RANGE      = 6;
const NOTIFY_CHAR_LIMIT  = 500;   // body chars per chunk (header overhead accounted for separately)
const NOTIFY_HEADER_MAX  = 45;    // "[WarEstimate: LongName] Part 10/10\n"
const NOTIFY_TOTAL_MAX   = NOTIFY_CHAR_LIMIT - NOTIFY_HEADER_MAX;
const NOTIFY_PER_TICK    = 10;
const MONITOR_SAMPLES    = 10;
const MONITOR_INTERVAL   = 1000;

// ── Nuke damage constants (mirrors nukeAnalyze.js) ────────────────
const NUKE_DIRECT_DAMAGE     = 10000000;
const NUKE_AREA_DAMAGE       =  5000000;
const NUKE_ENERGY_COST       =   300000;
const NUKE_GHODIUM_COST      =     5000;
const REPAIR_HITS_PER_ENERGY =      100;

/** Structure build costs in energy (matches nukeAnalyze BUILD_COST) */
const NUKE_BUILD_COST = {
    spawn: 15000, extension: 3000, road: 300, wall: 1, rampart: 1,
    link: 5000, storage: 30000, tower: 5000, observer: 8000,
    powerSpawn: 100000, extractor: 5000, lab: 50000, terminal: 100000,
    container: 5000, nuker: 100000, factory: 100000
};

// Category weights
const CATEGORY_WEIGHTS = {
    forceProjection: 0.20, spawnThroughput: 0.20, attrition: 0.20,
    boostCapacity: 0.15, defensiveDepth: 0.15, multiFrontStrain: 0.10
};

// Internal metric weights per category per time horizon
const WEIGHTS = {
    forceProjection: {
        short:  { distance: 0.15, spawnsSupport: 0.20, towersTheater: 0.15, terminalRelay: 0.20, nukeOverlap: 0.10, roomsSupport: 0.20 },
        medium: { distance: 0.10, spawnsSupport: 0.18, towersTheater: 0.12, terminalRelay: 0.22, nukeOverlap: 0.15, roomsSupport: 0.23 },
        long:   { distance: 0.08, spawnsSupport: 0.12, towersTheater: 0.08, terminalRelay: 0.25, nukeOverlap: 0.20, roomsSupport: 0.27 }
    },
    spawnThroughput: {
        short:  { energyCap: 0.20, activeSpawns: 0.25, extensionFill: 0.15, operatorBoost: 0.15, creepsPer100: 0.25 },
        medium: { energyCap: 0.20, activeSpawns: 0.20, extensionFill: 0.15, operatorBoost: 0.18, creepsPer100: 0.27 },
        long:   { energyCap: 0.15, activeSpawns: 0.15, extensionFill: 0.10, operatorBoost: 0.20, creepsPer100: 0.40 }
    },
    attrition: {
        short:  { warChest: 0.25, baseIncome: 0.08, econProduction: 0.05, tradeLiquidity: 0.07, burnRate: 0.18, terminalDepth: 0.12, mineralPressure: 0.10, depletion: 0.15 },
        medium: { warChest: 0.12, baseIncome: 0.10, econProduction: 0.15, tradeLiquidity: 0.10, burnRate: 0.15, terminalDepth: 0.18, mineralPressure: 0.08, depletion: 0.12 },
        long:   { warChest: 0.05, baseIncome: 0.08, econProduction: 0.25, tradeLiquidity: 0.12, burnRate: 0.12, terminalDepth: 0.20, mineralPressure: 0.06, depletion: 0.12 }
    },
    boostCapacity: {
        short:  { stockpile: 0.30, tierDistribution: 0.15, labCapacity: 0.10, baseMinerals: 0.10, replenishment: 0.10, defensiveBoosts: 0.25 },
        medium: { stockpile: 0.15, tierDistribution: 0.12, labCapacity: 0.20, baseMinerals: 0.18, replenishment: 0.20, defensiveBoosts: 0.15 },
        long:   { stockpile: 0.08, tierDistribution: 0.10, labCapacity: 0.25, baseMinerals: 0.22, replenishment: 0.25, defensiveBoosts: 0.10 }
    },
    defensiveDepth: {
        short:  { repairThroughput: 0.20, wallHPPool: 0.15, safeModeInventory: 0.25, towerSustain: 0.15, gclHeadroom: 0.05, rebuildCapacity: 0.05, controllerFort: 0.15 },
        medium: { repairThroughput: 0.18, wallHPPool: 0.20, safeModeInventory: 0.15, towerSustain: 0.20, gclHeadroom: 0.10, rebuildCapacity: 0.07, controllerFort: 0.10 },
        long:   { repairThroughput: 0.12, wallHPPool: 0.15, safeModeInventory: 0.10, towerSustain: 0.20, gclHeadroom: 0.18, rebuildCapacity: 0.15, controllerFort: 0.10 }
    },
    multiFrontStrain: {
        short:  { spawnAllocation: 0.20, terminalBandwidth: 0.15, geoSpread: 0.20, reserveRooms: 0.10, perFrontRatio: 0.25, ownStrain: 0.10 },
        medium: { spawnAllocation: 0.18, terminalBandwidth: 0.20, geoSpread: 0.18, reserveRooms: 0.15, perFrontRatio: 0.18, ownStrain: 0.11 },
        long:   { spawnAllocation: 0.15, terminalBandwidth: 0.22, geoSpread: 0.15, reserveRooms: 0.22, perFrontRatio: 0.13, ownStrain: 0.13 }
    }
};

// Normalization caps
const CAPS = {
    spawnsInTheater: 18, towersInTheater: 36, roomsInSupport: 10,
    warChest: 20000000, incomePerTick: 120, economicTiers: 8,
    marketScore: 25, burnRate: 800, terminalDepth: 10,
    combatBoosts: 60000, labCount: 10, baseMineralTypes: 8,
    repairPerTick: 4800, wallHPMedian: 1000000000, safeModeTicks: 100000,
    towerEnergyPct: 1, maxRoomSpread: 30, energyCap: 12300, activeSpawns: 18
};

// Combat boost compounds
const COMBAT_BOOSTS_ATTACK  = ['UH', 'UH2O', 'XUH2O'];
const COMBAT_BOOSTS_RANGED  = ['KO', 'KHO2', 'XKHO2'];
const COMBAT_BOOSTS_HEAL    = ['LO', 'LHO2', 'XLHO2'];
const COMBAT_BOOSTS_TOUGH   = ['GO', 'GHO2', 'XGHO2'];
const ALL_COMBAT_BOOSTS     = [...COMBAT_BOOSTS_ATTACK, ...COMBAT_BOOSTS_RANGED, ...COMBAT_BOOSTS_HEAL, ...COMBAT_BOOSTS_TOUGH];
const T3_BOOSTS             = ['XUH2O', 'XKHO2', 'XLHO2', 'XGHO2', 'XZH2O', 'XZHO2', 'XKH2O', 'XLH2O', 'XGH2O', 'XUHO2'];
const BASE_MINERALS         = ['H', 'O', 'U', 'L', 'K', 'Z', 'X', 'G'];

const HIGHWAY_DEPOSITS        = ['metal', 'biomass', 'silicon', 'mist'];
const COMPRESSED_COMMODITIES  = ['utrium_bar', 'lemergium_bar', 'zynthium_bar', 'keanium_bar', 'ghodium_melt', 'oxidant', 'reductant', 'purifier', 'battery'];
const REGIONAL_COMMODITIES    = ['wire', 'cell', 'alloy', 'condensate'];
const LEVEL_COMMODITIES       = ['composite', 'crystal', 'liquid', 'switch', 'phlegm', 'tube', 'concentrate', 'transistor', 'tissue', 'fixtures', 'extract', 'microchip', 'muscle', 'frame', 'spirit', 'circuit', 'organoid', 'hydraulics', 'emanation', 'device', 'organism', 'machine', 'essence'];
const LAB_PRODUCTS_LIST       = ['OH', 'ZK', 'UL', 'UH', 'UO', 'KH', 'KO', 'LH', 'LO', 'ZH', 'ZO', 'GH', 'GO', 'UH2O', 'UHO2', 'KH2O', 'KHO2', 'LH2O', 'LHO2', 'ZH2O', 'ZHO2', 'GH2O', 'GHO2', 'XUH2O', 'XUHO2', 'XKH2O', 'XKHO2', 'XLH2O', 'XLHO2', 'XZH2O', 'XZHO2', 'XGH2O', 'XGHO2'];


// ═══════════════════════════════════════════════════════════════════
// ROOM COORDINATE HELPERS
// ═══════════════════════════════════════════════════════════════════

function parseRoomName(roomName) {
    const match = roomName.match(/^([WE])(\d+)([NS])(\d+)$/);
    if (!match) return null;
    const [, ew, ewNum, ns, nsNum] = match;
    let wx = parseInt(ewNum, 10);
    let wy = parseInt(nsNum, 10);
    if (ew === 'W') wx = -wx - 1;
    if (ns === 'N') wy = -wy - 1;
    return { wx, wy };
}

function getRoomDistance(room1, room2) {
    const c1 = parseRoomName(room1);
    const c2 = parseRoomName(room2);
    if (!c1 || !c2) return Infinity;
    return Math.max(Math.abs(c1.wx - c2.wx), Math.abs(c1.wy - c2.wy));
}

function canNuke(fromRoom, toRoom) {
    return getRoomDistance(fromRoom, toRoom) <= NUKE_RANGE;
}

function avgDistanceBetweenRooms(rooms) {
    if (rooms.length < 2) return 0;
    let total = 0, count = 0;
    for (let i = 0; i < rooms.length; i++) {
        for (let j = i + 1; j < rooms.length; j++) {
            total += getRoomDistance(rooms[i], rooms[j]);
            count++;
        }
    }
    return count > 0 ? total / count : 0;
}

function findFrontLine(enemyRooms, ownRooms, enemyOwner, maxDepth) {
    maxDepth = maxDepth || 15;
    const ownSet   = new Set(ownRooms);
    let myName = '';
    for (const name in Game.rooms) {
        const r = Game.rooms[name];
        if (r.controller && r.controller.my) { myName = r.controller.owner.username; break; }
    }

    const visited = {}, parent = {}, queue = [];
    let head = 0;
    for (const er of enemyRooms) { visited[er] = 0; queue.push([er, 0]); }

    const reached = [];
    while (head < queue.length) {
        const [current, dist] = queue[head++];
        if (ownSet.has(current) && dist > 0) {
            const prev = parent[current];
            let entryDir = '';
            if (prev) {
                const pc = parseRoomName(prev), cc = parseRoomName(current);
                if (pc && cc) {
                    if (pc.wy < cc.wy) entryDir = 'N';
                    else if (pc.wy > cc.wy) entryDir = 'S';
                    else if (pc.wx < cc.wx) entryDir = 'E';
                    else if (pc.wx > cc.wx) entryDir = 'W';
                }
            }
            reached.push({ room: current, distance: dist, entryDir });
            continue;
        }
        if (dist >= maxDepth) continue;
        const exits = Game.map.describeExits(current);
        if (!exits) continue;
        for (const dir in exits) {
            const neighbor = exits[dir];
            if (visited[neighbor] !== undefined) continue;
            const status = Game.map.getRoomStatus(neighbor);
            if (status && status.status === 'closed') { visited[neighbor] = Infinity; continue; }
            const room = Game.rooms[neighbor];
            if (room && room.controller && room.controller.owner) {
                const owner = room.controller.owner.username;
                if (owner !== myName && owner !== enemyOwner) { visited[neighbor] = Infinity; continue; }
            }
            visited[neighbor] = dist + 1;
            parent[neighbor] = current;
            queue.push([neighbor, dist + 1]);
        }
    }

    reached.sort((a, b) => a.distance - b.distance);
    const reachedSet = new Set(reached.map(r => r.room));
    return { frontLine: reached, unreachable: ownRooms.filter(r => !reachedSet.has(r)) };
}


// ═══════════════════════════════════════════════════════════════════
// NUKE SWEEP (inline from nukeAnalyze — no external dependency)
// ═══════════════════════════════════════════════════════════════════

/**
 * Fetch market buy price for a resource.
 * Tries marketBuy module first, falls back to raw order scan.
 */
function getMarketBuyPrice(resource) {
    try {
        const mb = require('marketBuy');
        if (mb && typeof mb.computeBuyPrice === 'function') return mb.computeBuyPrice(resource);
    } catch (e) { /* unavailable */ }
    try {
        const orders = Game.market.getAllOrders({ type: ORDER_BUY, resourceType: resource });
        if (!orders || orders.length === 0) return 0;
        return Math.max(...orders.map(o => o.price));
    } catch (e) { return 0; }
}

/**
 * Build a resource→price cache for all resources present in a room's structures.
 */
function buildNukePriceCache(room) {
    const cache = {};
    const addStore = store => {
        if (!store) return;
        for (const res in store) {
            if (cache[res] === undefined) cache[res] = getMarketBuyPrice(res);
        }
    };
    room.find(FIND_STRUCTURES).forEach(s => addStore(s.store));
    if (cache[RESOURCE_ENERGY]  === undefined) cache[RESOURCE_ENERGY]  = getMarketBuyPrice(RESOURCE_ENERGY);
    if (cache[RESOURCE_GHODIUM] === undefined) cache[RESOURCE_GHODIUM] = getMarketBuyPrice(RESOURCE_GHODIUM);
    return cache;
}

/**
 * Analyse a single 5×5 nuke strike centred on (cx, cy).
 * Returns totalCredits damaged/destroyed.
 */
function analyzeNukeStrike(cx, cy, structureMap, priceCache) {
    const ePrice = priceCache[RESOURCE_ENERGY] || 0;
    let totalCredits = 0;

    for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
            const x = cx + dx, y = cy + dy;
            if (x < 0 || x > 49 || y < 0 || y > 49) continue;
            const nukeHits = (dx === 0 && dy === 0) ? NUKE_DIRECT_DAMAGE : NUKE_AREA_DAMAGE;
            const structs  = structureMap[x + ',' + y];
            if (!structs || structs.length === 0) continue;

            const ramparts  = structs.filter(s => s.structureType === STRUCTURE_RAMPART);
            const buildings = structs.filter(s =>
                s.structureType !== STRUCTURE_RAMPART &&
                s.structureType !== STRUCTURE_ROAD    &&
                s.structureType !== STRUCTURE_WALL
            );

            let bestRampart = null;
            for (const r of ramparts) {
                if (!bestRampart || r.hits > bestRampart.hits) bestRampart = r;
            }
            const rampartBlocks = bestRampart && (bestRampart.hits > nukeHits);

            for (const bld of buildings) {
                if (!rampartBlocks) {
                    // Building destroyed
                    const buildCost = (NUKE_BUILD_COST[bld.structureType] || 0) * ePrice;
                    let storedVal = 0;
                    if (bld.store) {
                        for (const res in bld.store) {
                            const amt = bld.store[res] || 0;
                            if (amt > 0) storedVal += amt * (priceCache[res] !== undefined ? priceCache[res] : getMarketBuyPrice(res));
                        }
                    }
                    totalCredits += buildCost + storedVal;
                }
            }

            if (bestRampart) {
                if (!rampartBlocks) {
                    // Rampart dies — count HP investment
                    totalCredits += (bestRampart.hits / REPAIR_HITS_PER_ENERGY) * ePrice;
                } else {
                    // Rampart survives but must be repaired
                    totalCredits += (nukeHits / REPAIR_HITS_PER_ENERGY) * ePrice;
                }
            }
        }
    }
    return totalCredits;
}

/**
 * Full 5×5 sweep over a room to find the optimal nuke strike.
 * Returns { x, y, damage, nukeCost, percent, destroyed[] }.
 * destroyed[] is a brief list of structure types/positions killed at the best strike.
 */
function computeBestNukeStrike(room) {
    const priceCache  = buildNukePriceCache(room);
    const ePrice      = priceCache[RESOURCE_ENERGY]  || 0;
    const ghPrice     = priceCache[RESOURCE_GHODIUM] || 0;
    const nukeCost    = (NUKE_ENERGY_COST * ePrice) + (NUKE_GHODIUM_COST * ghPrice);

    // Build position→structures map
    const structureMap = {};
    room.find(FIND_STRUCTURES).forEach(s => {
        const key = s.pos.x + ',' + s.pos.y;
        if (!structureMap[key]) structureMap[key] = [];
        structureMap[key].push(s);
    });

    let bestX = 25, bestY = 25, bestDmg = 0;
    for (let cx = 2; cx <= 47; cx++) {
        for (let cy = 2; cy <= 47; cy++) {
            const dmg = analyzeNukeStrike(cx, cy, structureMap, priceCache);
            if (dmg > bestDmg) { bestDmg = dmg; bestX = cx; bestY = cy; }
        }
    }

    // Collect what gets destroyed at the best position (for the report)
    const destroyed = [];
    if (bestDmg > 0) {
        for (let dx = -2; dx <= 2; dx++) {
            for (let dy = -2; dy <= 2; dy++) {
                const x = bestX + dx, y = bestY + dy;
                if (x < 0 || x > 49 || y < 0 || y > 49) continue;
                const nukeHits = (dx === 0 && dy === 0) ? NUKE_DIRECT_DAMAGE : NUKE_AREA_DAMAGE;
                const structs  = structureMap[x + ',' + y];
                if (!structs) continue;
                const ramparts  = structs.filter(s => s.structureType === STRUCTURE_RAMPART);
                const buildings = structs.filter(s =>
                    s.structureType !== STRUCTURE_RAMPART &&
                    s.structureType !== STRUCTURE_ROAD    &&
                    s.structureType !== STRUCTURE_WALL
                );
                let bestRampart = null;
                for (const r of ramparts) {
                    if (!bestRampart || r.hits > bestRampart.hits) bestRampart = r;
                }
                const rampartBlocks = bestRampart && bestRampart.hits > nukeHits;
                if (!rampartBlocks) {
                    for (const bld of buildings) destroyed.push(bld.structureType);
                }
            }
        }
    }

    // Group destroyed types
    const byType = {};
    for (const t of destroyed) byType[t] = (byType[t] || 0) + 1;
    const destroyedSummary = Object.entries(byType).map(([t, n]) => n > 1 ? n + 'x ' + t : t).join(', ');

    const pct = nukeCost > 0 ? (bestDmg / nukeCost * 100).toFixed(1) : '∞';

    return {
        x: bestX, y: bestY,
        damage: bestDmg,
        nukeCost: nukeCost,
        percent: parseFloat(pct),
        destroyedSummary: destroyedSummary || 'nothing killable'
    };
}

/** Format credit value compactly */
function fmtCr(n) {
    if (!n) return '0 cr';
    if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M cr';
    if (n >= 1000)    return (n / 1000).toFixed(1) + 'k cr';
    return Math.round(n) + ' cr';
}


// ═══════════════════════════════════════════════════════════════════
// DATA GATHERING
// ═══════════════════════════════════════════════════════════════════

function gatherRoomWarData(room) {
    const data = {
        room: room.name,
        rcl:  room.controller ? room.controller.level : 0,
        owner: room.controller && room.controller.owner ? room.controller.owner.username : null
    };

    const spawns      = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_SPAWN });
    const extensions  = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_EXTENSION });
    const towers      = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER });
    const storage     = room.storage;
    const terminal    = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TERMINAL })[0];
    const nuker       = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_NUKER })[0];
    const factory     = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_FACTORY })[0];
    const labs        = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_LAB });
    const ramparts    = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_RAMPART });
    const walls       = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_WALL });
    const links       = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_LINK });
    const containers  = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_CONTAINER });
    const powerSpawn  = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_POWER_SPAWN })[0];
    const extractor   = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_EXTRACTOR })[0];
    const sources     = room.find(FIND_SOURCES);
    const mineral     = room.find(FIND_MINERALS)[0];
    const allCreeps   = room.find(FIND_CREEPS);
    const powerCreeps = room.find(FIND_POWER_CREEPS);

    // Spawning
    data.spawns          = spawns.length;
    data.extensions      = extensions.length;
    data.energyCapacity  = room.energyCapacityAvailable;
    data.energyAvailable = room.energyAvailable;
    if (extensions.length > 0) {
        const totalE = extensions.reduce((s, e) => s + e.store[RESOURCE_ENERGY], 0);
        const totalC = extensions.reduce((s, e) => s + e.store.getCapacity(RESOURCE_ENERGY), 0);
        data.extensionFillPct = totalC > 0 ? totalE / totalC : 0;
    } else {
        data.extensionFillPct = 0;
    }

    // Operator
    data.hasOperator = false;
    for (const pc of powerCreeps) {
        if (pc.powers && pc.powers[PWR_OPERATE_SPAWN]) {
            data.hasOperator  = true;
            data.operatorLevel = pc.powers[PWR_OPERATE_SPAWN].level || 0;
            break;
        }
    }
    data.powerCreepCount = powerCreeps.length;

    // Towers
    data.towers         = towers.length;
    data.towerEnergy    = towers.reduce((s, t) => s + t.store[RESOURCE_ENERGY], 0);
    data.towerCapacity  = towers.reduce((s, t) => s + t.store.getCapacity(RESOURCE_ENERGY), 0);
    data.towerEnergyPct = data.towerCapacity > 0 ? data.towerEnergy / data.towerCapacity : 0;
    data.emptyTowers    = towers.filter(t => t.store[RESOURCE_ENERGY] === 0).length;

    // Storage
    data.hasStorage      = !!storage;
    data.storageEnergy   = storage ? (storage.store[RESOURCE_ENERGY] || 0) : 0;
    data.storageTotal    = storage ? storage.store.getUsedCapacity() : 0;
    data.storageCapacity = storage ? storage.store.getCapacity() : 0;
    data.storageFillPct  = data.storageCapacity > 0 ? data.storageTotal / data.storageCapacity : 0;

    // Terminal
    data.hasTerminal         = !!terminal;
    data.terminalEnergy      = terminal ? (terminal.store[RESOURCE_ENERGY] || 0) : 0;
    data.terminalTotal       = terminal ? terminal.store.getUsedCapacity() : 0;
    const termNonEnergy      = terminal ? Object.keys(terminal.store).filter(r => r !== RESOURCE_ENERGY && terminal.store[r] > 0) : [];
    data.terminalResourceCount = termNonEnergy.length;
    data.terminalLiveness    = !terminal ? 0
        : (data.terminalEnergy === 0 && data.terminalResourceCount === 0) ? 0
        : (data.terminalEnergy > 0   && data.terminalResourceCount === 0) ? 0.3
        : 1.0;

    // Nuker
    data.hasNuker    = !!nuker;
    data.nukerReady  = false;
    if (nuker) {
        const nE = nuker.store[RESOURCE_ENERGY] || 0;
        const nG = nuker.store[RESOURCE_GHODIUM] || 0;
        data.nukerReady = nE >= nuker.store.getCapacity(RESOURCE_ENERGY) &&
                          nG >= nuker.store.getCapacity(RESOURCE_GHODIUM) &&
                          (nuker.cooldown || 0) === 0;
    }

    // Factory
    data.hasFactory   = !!factory;
    data.factoryLevel = factory ? (factory.level || 0) : 0;

    // Resources across storage + terminal
    const allResources = new Set();
    [storage, terminal].filter(Boolean).forEach(st => {
        Object.keys(st.store).filter(r => st.store[r] > 0).forEach(r => allResources.add(r));
    });
    data.resourceDiversity = allResources.size;

    // Economic chain depth
    data.econTiers = 0;
    if (factory) data.econTiers++;
    if (data.factoryLevel >= 1) data.econTiers++;
    if (HIGHWAY_DEPOSITS.some(r => allResources.has(r))) data.econTiers++;
    if (COMPRESSED_COMMODITIES.some(r => allResources.has(r))) data.econTiers++;
    if (REGIONAL_COMMODITIES.some(r => allResources.has(r))) data.econTiers++;
    if (LEVEL_COMMODITIES.some(r => allResources.has(r))) data.econTiers++;
    if (LAB_PRODUCTS_LIST.some(r => allResources.has(r))) data.econTiers++;
    const activeLabs = labs.filter(l => l.cooldown > 0 || (l.mineralType && l.store[l.mineralType] > 0));
    if (activeLabs.length > 0) data.econTiers++;

    // Labs
    data.labCount       = labs.length;
    data.activeLabCount = activeLabs.length;

    // Market orders
    const roomOrders      = Game.market.getAllOrders({ roomName: room.name });
    data.marketOrders     = roomOrders.length;
    data.marketBuyOrders  = roomOrders.filter(o => o.type === ORDER_BUY).length;
    data.marketSellOrders = roomOrders.filter(o => o.type === ORDER_SELL).length;

    // Combat boosts
    let totalCombatBoosts = 0, t3Boosts = 0, defensiveBoosts = 0;
    const boostSources = [storage, terminal].filter(Boolean);
    for (const lab of labs) {
        if (lab.mineralType) boostSources.push({ [lab.mineralType]: lab.store[lab.mineralType] || 0 });
    }
    for (const store of boostSources) {
        const s = store.store || store;
        for (const b of ALL_COMBAT_BOOSTS) totalCombatBoosts += s[b] || 0;
        for (const b of T3_BOOSTS)         t3Boosts          += s[b] || 0;
        for (const b of COMBAT_BOOSTS_TOUGH) defensiveBoosts  += s[b] || 0;
        for (const b of COMBAT_BOOSTS_HEAL)  defensiveBoosts  += s[b] || 0;
    }
    data.combatBoosts    = totalCombatBoosts;
    data.t3Boosts        = t3Boosts;
    data.defensiveBoosts = defensiveBoosts;
    data.t3Equivalent    = t3Boosts + (totalCombatBoosts - t3Boosts) * 0.5;
    data.boostedCreeps   = Math.floor(data.t3Equivalent / 1500);
    data.baseMineralsPresent = BASE_MINERALS.filter(m => allResources.has(m)).length;

    // Defense
    const allDefenses = ramparts.concat(walls);
    data.ramparts    = ramparts.length;
    data.walls       = walls.length;
    data.defenseCount = allDefenses.length;
    if (allDefenses.length > 0) {
        const sorted = allDefenses.map(d => d.hits).sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        data.medianDefenseHits = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        data.minDefenseHits    = sorted[0];
    } else {
        data.medianDefenseHits = 0;
        data.minDefenseHits    = 0;
    }
    data.avgDefenseHits  = allDefenses.length > 0 ? allDefenses.reduce((s, d) => s + d.hits, 0) / allDefenses.length : 0;
    data.totalDefenseHP  = allDefenses.reduce((s, d) => s + d.hits, 0);
    data.weakRamparts    = ramparts.filter(r => r.hits < 100000).length;

    // Safe mode / controller
    data.safeModeAvailable = room.controller ? room.controller.safeModeAvailable || 0 : 0;
    data.safeModeCooldown  = room.controller ? room.controller.safeModeCooldown  || 0 : 0;
    data.ticksToDowngrade  = room.controller ? room.controller.ticksToDowngrade  || 0 : 0;

    // Sources
    data.sources        = sources.length;
    data.mineral        = mineral ? mineral.mineralType : null;
    data.hasExtractor   = !!extractor;
    let sourceInfra = 0;
    for (const source of sources) {
        if (source.pos.findInRange(links, 3).length > 0 || source.pos.findInRange(containers, 3).length > 0)
            sourceInfra++;
    }
    data.sourceInfraRatio = sources.length > 0 ? sourceInfra / sources.length : 0;
    data.estimatedIncome  = sources.length * 10 * (0.5 + 0.5 * data.sourceInfraRatio);

    // Creeps
    data.totalCreeps       = allCreeps.length;
    data.boostedCreepCount = allCreeps.filter(c => c.body.some(p => p.boost)).length;
    data.largeCreeps       = allCreeps.filter(c => c.body.length >= 30).length;

    // Links / tower feeding
    data.links = links.length;
    data.towersWithLinks = towers.filter(t => t.pos.findInRange(links, 3).length > 0).length;

    // ── Critical structure / nuke target analysis ──────────────────
    const criticalStructures = [];
    const critTypes = [
        { list: spawns,                              type: 'spawn',      hp: 5000,   priority: 1 },
        { list: storage ? [storage] : [],            type: 'storage',    hp: 10000,  priority: 2 },
        { list: terminal ? [terminal] : [],          type: 'terminal',   hp: 3000,   priority: 3 },
        { list: factory ? [factory] : [],            type: 'factory',    hp: 2000,   priority: 4 },
        { list: powerSpawn ? [powerSpawn] : [],      type: 'powerSpawn', hp: 5000,   priority: 5 },
        { list: labs,                                type: 'lab',        hp: 500,    priority: 6 },
        { list: towers,                              type: 'tower',      hp: 3000,   priority: 7 }
    ];
    for (const ct of critTypes) {
        for (const s of ct.list) {
            const coveringRampart = ramparts.find(r => r.pos.x === s.pos.x && r.pos.y === s.pos.y);
            criticalStructures.push({
                type: ct.type, x: s.pos.x, y: s.pos.y,
                hp: s.hits || ct.hp, priority: ct.priority,
                rampartHP: coveringRampart ? coveringRampart.hits : 0,
                protected: !!coveringRampart
            });
        }
    }
    data.criticalStructures = criticalStructures;

    // Best nuke targets (structure-cluster method — fast, used for TARGET PRIORITY)
    const NUKE_CENTER_DMG  = 10000000;
    const NUKE_SPLASH_DMG  = 5000000;
    const nukeTargets = [];
    const seenPos = new Set();
    for (const cs of criticalStructures) {
        let directKills = [], splashKills = [], directDamaged = [], splashDamaged = [];
        for (const other of criticalStructures) {
            const dist = Math.max(Math.abs(cs.x - other.x), Math.abs(cs.y - other.y));
            const dmg  = dist === 0 ? NUKE_CENTER_DMG : (dist <= 2 ? NUKE_SPLASH_DMG : 0);
            if (!dmg) continue;
            const totalHP = other.rampartHP + other.hp;
            if (dmg >= totalHP) (dist === 0 ? directKills : splashKills).push(other.type);
            else                (dist === 0 ? directDamaged : splashDamaged).push(other.type);
        }
        const killCount     = directKills.length + splashKills.length;
        const priorityScore = [...directKills, ...splashKills].reduce((s, type) => {
            if (type === 'spawn')                    return s + 10;
            if (type === 'storage' || type === 'terminal') return s + 7;
            if (type === 'tower')                    return s + 5;
            if (type === 'factory' || type === 'powerSpawn') return s + 4;
            return s + 2;
        }, 0);
        if ((killCount > 0 || directDamaged.length > 0) && !seenPos.has(cs.x + ',' + cs.y)) {
            seenPos.add(cs.x + ',' + cs.y);
            nukeTargets.push({ x: cs.x, y: cs.y, kills: [...directKills, ...splashKills], killCount, damaged: [...directDamaged, ...splashDamaged], priorityScore });
        }
    }
    data.nukeTargets = nukeTargets.sort((a, b) => b.priorityScore - a.priorityScore).slice(0, 5);

    // Vulnerability summary
    const unprotectedCrit  = criticalStructures.filter(c => !c.protected);
    const weakProtected    = criticalStructures.filter(c => c.protected && c.rampartHP < NUKE_CENTER_DMG);
    const strongProtected  = criticalStructures.filter(c => c.protected && c.rampartHP >= NUKE_CENTER_DMG);
    data.unprotectedCount  = unprotectedCrit.length;
    data.weakProtectedCount  = weakProtected.length;
    data.strongProtectedCount = strongProtected.length;
    data.unprotectedTypes  = [...new Set(unprotectedCrit.map(c => c.type))];
    data.minCritRampartHP  = weakProtected.length > 0  ? Math.min(...weakProtected.map(c => c.rampartHP))  : 0;
    data.maxCritRampartHP  = strongProtected.length > 0 ? Math.max(...strongProtected.map(c => c.rampartHP)) : 0;

    const spawnRamparts    = criticalStructures.filter(c => c.type === 'spawn' && c.protected).map(c => c.rampartHP);
    data.nukesToBreachSpawn = spawnRamparts.length > 0 ? Math.ceil(Math.min(...spawnRamparts) / NUKE_CENTER_DMG) : 0;

    // ── Full 5×5 nuke sweep (credit-damage optimal strike) ──────────
    // Only run if energy price is available (avoids all-zero results)
    data.bestNukeStrike = computeBestNukeStrike(room);

    return data;
}

function gatherSnapshot(room) {
    const snap = { tick: Game.time, room: room.name };
    const storage    = room.storage;
    const terminal   = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TERMINAL })[0];
    const spawns     = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_SPAWN });
    const towers     = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER });
    const labs       = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_LAB });
    const extensions = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_EXTENSION });
    const ramparts   = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_RAMPART });
    const walls      = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_WALL });
    const nuker      = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_NUKER })[0];
    const factory    = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_FACTORY })[0];
    const powerSpawn = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_POWER_SPAWN })[0];

    snap.storageE  = storage  ? (storage.store[RESOURCE_ENERGY]  || 0) : 0;
    snap.terminalE = terminal ? (terminal.store[RESOURCE_ENERGY] || 0) : 0;
    snap.spawns    = spawns.length;
    snap.towers    = towers.length;
    snap.ramparts  = ramparts.length;
    snap.totalLabs = labs.length;

    snap.towersEmpty = 0; snap.towersLow = 0;
    if (towers.length > 0) {
        snap.towerEPct = towers.reduce((s, t) => s + (t.store[RESOURCE_ENERGY] || 0), 0) / (towers.length * 1000);
        for (const t of towers) {
            const e = t.store[RESOURCE_ENERGY] || 0;
            if (e === 0) snap.towersEmpty++;
            else if (e < 250) snap.towersLow++;
        }
    } else { snap.towerEPct = 0; }

    snap.activeLabs = labs.filter(l => l.cooldown > 0 || (l.mineralType && l.store[l.mineralType] > 0)).length;

    if (extensions.length > 0) {
        const totalE = extensions.reduce((s, e) => s + (e.store[RESOURCE_ENERGY] || 0), 0);
        const totalC = extensions.reduce((s, e) => s + e.store.getCapacity(RESOURCE_ENERGY), 0);
        snap.extFillPct = totalC > 0 ? Math.round(totalE / totalC * 100) : 0;
    } else { snap.extFillPct = 0; }

    const allDef = [...ramparts, ...walls];
    if (allDef.length > 0) {
        const sorted = allDef.map(d => d.hits).sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        snap.wallMedHP = sorted.length % 2 !== 0 ? sorted[mid] : Math.floor((sorted[mid - 1] + sorted[mid]) / 2);
        snap.wallMinHP = sorted[0];
    } else { snap.wallMedHP = 0; snap.wallMinHP = 0; }

    snap.weakRamparts = ramparts.filter(r => r.hits < 100000).length;

    function hasProtection(structures) {
        return structures.filter(s => ramparts.some(r => r.pos.x === s.pos.x && r.pos.y === s.pos.y && r.hits >= 10000000)).length;
    }
    snap.spawnsProtected   = hasProtection(spawns);
    snap.towersProtected   = hasProtection(towers);
    snap.storageProtected  = storage  ? hasProtection([storage])  : 0;
    snap.terminalProtected = terminal ? hasProtection([terminal]) : 0;

    snap.safeModes     = room.controller ? (room.controller.safeModeAvailable || 0) : 0;
    const rcl = room.controller ? room.controller.level : 0;
    const ttd = room.controller ? (room.controller.ticksToDowngrade || 0) : 0;
    snap.rcl           = rcl;
    snap.downgradeAlert = (rcl === 8 && ttd < 100000) ? ttd : 0;

    snap.nukerG  = nuker ? (nuker.store[RESOURCE_GHODIUM] || 0) : -1;
    snap.nukerE  = nuker ? (nuker.store[RESOURCE_ENERGY]  || 0) : -1;
    snap.factoryLevel = factory ? (factory.level || 0) : -1;
    snap.psFueled = powerSpawn
        ? ((powerSpawn.store[RESOURCE_POWER] || 0) > 0 && (powerSpawn.store[RESOURCE_ENERGY] || 0) > 0)
        : null;

    let boostAttack = 0, boostRanged = 0, boostHeal = 0, boostTough = 0;
    const stores = [storage, terminal].filter(Boolean);
    for (const store of stores) {
        for (const b of COMBAT_BOOSTS_ATTACK) boostAttack += (store.store[b] || 0);
        for (const b of COMBAT_BOOSTS_RANGED) boostRanged += (store.store[b] || 0);
        for (const b of COMBAT_BOOSTS_HEAL)   boostHeal   += (store.store[b] || 0);
        for (const b of COMBAT_BOOSTS_TOUGH)  boostTough  += (store.store[b] || 0);
    }
    snap.boostAttack = boostAttack; snap.boostRanged = boostRanged;
    snap.boostHeal   = boostHeal;   snap.boostTough  = boostTough;
    snap.combatBoosts = boostAttack + boostRanged + boostHeal + boostTough;

    snap.resourceDiversity = 0;
    const resources = {};
    for (const store of stores) {
        for (const res of Object.keys(store.store)) {
            const amt = store.store[res] || 0;
            if (amt > 100) resources[res] = (resources[res] || 0) + amt;
        }
    }
    snap.resourceDiversity = Object.keys(resources).length;
    snap.resources = resources;

    return snap;
}

function gatherOwnData() {
    const rooms = [];
    for (const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if (!room.controller || !room.controller.my) continue;
        rooms.push(gatherRoomWarData(room));
    }
    return rooms;
}

function getMyObservers() {
    const observerMap = {};
    for (const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if (!room.controller || !room.controller.my) continue;
        const observer = room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_OBSERVER })[0];
        if (observer) observerMap[roomName] = observer;
    }
    return observerMap;
}

function findObserverForRoom(targetRoom, observerMap) {
    const target = parseRoomName(targetRoom);
    if (!target) return null;
    for (const obsRoom in observerMap) {
        const oc = parseRoomName(obsRoom);
        if (!oc) continue;
        if (Math.max(Math.abs(target.wx - oc.wx), Math.abs(target.wy - oc.wy)) <= OBSERVER_RANGE)
            return observerMap[obsRoom];
    }
    return null;
}

function findAllObserversForRoom(targetRoom, observerMap) {
    const target = parseRoomName(targetRoom);
    if (!target) return [];
    return Object.entries(observerMap).filter(([obsRoom]) => {
        const oc = parseRoomName(obsRoom);
        return oc && Math.max(Math.abs(target.wx - oc.wx), Math.abs(target.wy - oc.wy)) <= OBSERVER_RANGE;
    }).map(([, obs]) => obs);
}


// ═══════════════════════════════════════════════════════════════════
// SCORING
// ═══════════════════════════════════════════════════════════════════

function norm(value, cap)        { return Math.max(0, Math.min(100, (value / cap) * 100)); }
function normInverse(value, cap) { return Math.max(0, Math.min(100, (1 - value / cap) * 100)); }

function aggregatePlayerData(roomDataArr, enemyRoomNames, ownRoomNames) {
    const isUs       = ownRoomNames !== undefined;
    const otherSide  = isUs ? (enemyRoomNames || []) : (ownRoomNames || []);
    const inTheater  = isUs
        ? roomDataArr.filter(r => otherSide.some(er => getRoomDistance(r.room, er) <= SUPPORT_RANGE))
        : roomDataArr.slice();
    const allRooms   = roomDataArr;
    const agg        = {};

    let totalMinDist = 0;
    for (const r of allRooms) {
        let minDist = Infinity;
        for (const er of otherSide) {
            const d = getRoomDistance(r.room, er);
            if (d < minDist) minDist = d;
        }
        totalMinDist += (minDist === Infinity ? 20 : minDist);
    }
    agg.avgMinDistance   = allRooms.length > 0 ? totalMinDist / allRooms.length : 20;
    agg.spawnsInTheater  = inTheater.reduce((s, r) => s + r.spawns, 0);
    agg.towersInTheater  = inTheater.reduce((s, r) => s + r.towers, 0);
    agg.terminalRelayScore = inTheater.reduce((s, r) => s + r.terminalLiveness, 0);
    agg.terminalRelayMax   = inTheater.length;

    let nukesCanHit = 0;
    for (const r of allRooms) {
        if (!r.hasNuker || !r.nukerReady) continue;
        for (const er of otherSide) {
            if (canNuke(r.room, er)) { nukesCanHit++; break; }
        }
    }
    agg.nukesCanHitEnemy = nukesCanHit;
    agg.roomsInSupport   = inTheater.length;

    agg.totalSpawns    = allRooms.reduce((s, r) => s + r.spawns, 0);
    agg.theaterSpawns  = inTheater.reduce((s, r) => s + r.spawns, 0);
    agg.avgEnergyCap   = allRooms.length > 0 ? allRooms.reduce((s, r) => s + r.energyCapacity, 0) / allRooms.length : 0;
    agg.avgExtFillPct  = allRooms.length > 0 ? allRooms.reduce((s, r) => s + r.extensionFillPct, 0) / allRooms.length : 0;
    agg.operatorRooms  = allRooms.filter(r => r.hasOperator).length;
    agg.hasAnyOperator = agg.operatorRooms > 0;
    const ticksPerCreep    = agg.hasAnyOperator ? 110 : 150;
    agg.creepsPer100Ticks  = agg.theaterSpawns * (100 / ticksPerCreep);

    agg.warChest             = allRooms.reduce((s, r) => s + r.storageEnergy + r.terminalEnergy, 0);
    agg.totalIncome          = allRooms.reduce((s, r) => s + r.estimatedIncome, 0);
    agg.avgEconTiers         = allRooms.length > 0 ? allRooms.reduce((s, r) => s + r.econTiers, 0) / allRooms.length : 0;
    agg.totalMarketOrders    = allRooms.reduce((s, r) => s + r.marketOrders, 0);
    agg.avgResourceDiversity = allRooms.length > 0 ? allRooms.reduce((s, r) => s + r.resourceDiversity, 0) / allRooms.length : 0;
    agg.marketScore          = agg.totalMarketOrders + agg.avgResourceDiversity / 5;
    agg.estimatedBurn        = agg.theaterSpawns * 80 + inTheater.reduce((s, r) => s + r.towers, 0) * 10;
    const backLine           = allRooms.filter(r => !inTheater.includes(r));
    agg.terminalNetworkDepth = backLine.filter(r => r.terminalLiveness >= 1.0 && r.storageEnergy > 50000).length;
    agg.avgMineralPressure   = allRooms.length > 0 ? allRooms.reduce((s, r) => s + r.storageFillPct, 0) / allRooms.length : 0;
    const netBurn            = agg.estimatedBurn - agg.totalIncome;
    agg.ticksToDepletion     = netBurn > 0 ? agg.warChest / netBurn : -1;

    agg.totalCombatBoosts    = allRooms.reduce((s, r) => s + r.combatBoosts, 0);
    agg.totalT3Boosts        = allRooms.reduce((s, r) => s + r.t3Boosts, 0);
    agg.totalT3Equivalent    = allRooms.reduce((s, r) => s + r.t3Equivalent, 0);
    agg.boostedCreeps        = Math.floor(agg.totalT3Equivalent / 1500);
    agg.totalLabCount        = allRooms.reduce((s, r) => s + r.labCount, 0);
    agg.totalActiveLabCount  = allRooms.reduce((s, r) => s + r.activeLabCount, 0);
    agg.maxBaseMinerals      = allRooms.length > 0 ? Math.max(...allRooms.map(r => r.baseMineralsPresent)) : 0;
    agg.replenishmentRate    = agg.totalActiveLabCount * (agg.maxBaseMinerals / BASE_MINERALS.length);
    agg.totalDefensiveBoosts = allRooms.reduce((s, r) => s + r.defensiveBoosts, 0);
    agg.t3Ratio              = agg.totalCombatBoosts > 0 ? agg.totalT3Boosts / agg.totalCombatBoosts : 0;

    agg.totalRepairPerTick   = allRooms.reduce((s, r) => s + r.towers * 800, 0);
    agg.theaterRepairPerTick = inTheater.reduce((s, r) => s + r.towers * 800, 0);
    agg.totalWallHP          = allRooms.reduce((s, r) => s + r.totalDefenseHP, 0);
    const allMinHits         = allRooms.filter(r => r.minDefenseHits > 0).map(r => r.minDefenseHits);
    agg.weakestWall          = allMinHits.length > 0 ? Math.min(...allMinHits) : 0;
    const allMedians         = allRooms.filter(r => r.medianDefenseHits > 0).map(r => r.medianDefenseHits).sort((a, b) => a - b);
    if (allMedians.length > 0) {
        const m = Math.floor(allMedians.length / 2);
        agg.medianWall = allMedians.length % 2 !== 0 ? allMedians[m] : Math.floor((allMedians[m - 1] + allMedians[m]) / 2);
    } else { agg.medianWall = 0; }
    agg.totalSafeModeTicks   = allRooms.reduce((s, r) => s + r.safeModeAvailable, 0) * 20000;
    agg.avgTowerEnergyPct    = allRooms.length > 0 ? allRooms.reduce((s, r) => s + r.towerEnergyPct, 0) / allRooms.length : 0;
    agg.towerLinkRatio       = allRooms.reduce((s, r) => s + r.towers, 0) > 0
        ? allRooms.reduce((s, r) => s + r.towersWithLinks, 0) / allRooms.reduce((s, r) => s + r.towers, 0) : 0;
    agg.towerSustainScore    = agg.avgTowerEnergyPct * 0.5 + agg.towerLinkRatio * 0.5;
    agg.roomCount            = allRooms.length;
    agg.gclLevel             = Game.gcl ? Game.gcl.level : allRooms.length;
    agg.gclHeadroom          = Math.max(0, agg.gclLevel - agg.roomCount);
    agg.avgRCL               = allRooms.length > 0 ? allRooms.reduce((s, r) => s + r.rcl, 0) / allRooms.length : 0;
    agg.avgStorageEnergy     = allRooms.length > 0 ? allRooms.reduce((s, r) => s + r.storageEnergy, 0) / allRooms.length : 0;
    agg.avgDowngrade         = allRooms.length > 0 ? allRooms.reduce((s, r) => s + r.ticksToDowngrade, 0) / allRooms.length : 0;
    agg.totalSafeModes       = allRooms.reduce((s, r) => s + r.safeModeAvailable, 0);
    agg.geoSpread            = avgDistanceBetweenRooms(allRooms.map(r => r.room));
    agg.reserveRooms         = backLine.length;
    agg.allRoomNames         = allRooms.map(r => r.room);

    return agg;
}

function scoreCategoryForSide(categoryName, horizon, agg, otherAgg) {
    const w = WEIGHTS[categoryName][horizon];
    let score = 0;
    const details = {};

    switch (categoryName) {
        case 'forceProjection': {
            const distScore    = Math.max(0, 100 - agg.avgMinDistance * 7);
            const spawnsScore  = norm(agg.spawnsInTheater, CAPS.spawnsInTheater);
            const towersScore  = norm(agg.towersInTheater, CAPS.towersInTheater);
            const termScore    = agg.terminalRelayMax > 0 ? (agg.terminalRelayScore / agg.terminalRelayMax) * 100 : 0;
            const nukeScore    = otherAgg.roomCount > 0 ? (agg.nukesCanHitEnemy / otherAgg.roomCount) * 100 : 0;
            const roomsScore   = norm(agg.roomsInSupport, CAPS.roomsInSupport);
            score = distScore * w.distance + spawnsScore * w.spawnsSupport + towersScore * w.towersTheater +
                    termScore * w.terminalRelay + nukeScore * w.nukeOverlap + roomsScore * w.roomsSupport;
            details.distance = Math.round(distScore); details.spawns = Math.round(spawnsScore);
            details.towers   = Math.round(towersScore); details.terminal = Math.round(termScore);
            details.nukes    = Math.round(nukeScore); details.rooms = Math.round(roomsScore);
            break;
        }
        case 'spawnThroughput': {
            const eCapScore   = norm(agg.avgEnergyCap, CAPS.energyCap);
            const activeScore = norm(agg.theaterSpawns, CAPS.activeSpawns);
            const extScore    = agg.avgExtFillPct * 100;
            const opScore     = agg.hasAnyOperator ? 100 : 0;
            const creepsScore = norm(agg.creepsPer100Ticks, 12);
            score = eCapScore * w.energyCap + activeScore * w.activeSpawns + extScore * w.extensionFill +
                    opScore * w.operatorBoost + creepsScore * w.creepsPer100;
            details.energyCap = Math.round(eCapScore); details.activeSpawns = Math.round(activeScore);
            details.extFill   = Math.round(extScore);  details.operator = Math.round(opScore);
            details.creepRate = Math.round(creepsScore);
            break;
        }
        case 'attrition': {
            const chestScore    = norm(agg.warChest, CAPS.warChest);
            const incomeScore   = norm(agg.totalIncome, CAPS.incomePerTick);
            const econScore     = norm(agg.avgEconTiers, CAPS.economicTiers) * 100 / 100;
            const tradeScore    = norm(agg.marketScore, CAPS.marketScore);
            const burnScore     = normInverse(agg.estimatedBurn, CAPS.burnRate);
            const termScore     = norm(agg.terminalNetworkDepth, CAPS.terminalDepth);
            const mineralScore  = normInverse(agg.avgMineralPressure, 1.0);
            const deplScore     = agg.ticksToDepletion < 0 ? 100 : norm(agg.ticksToDepletion, 100000);
            score = chestScore * w.warChest + incomeScore * w.baseIncome + econScore * w.econProduction +
                    tradeScore * w.tradeLiquidity + burnScore * w.burnRate + termScore * w.terminalDepth +
                    mineralScore * w.mineralPressure + deplScore * w.depletion;
            details.warChest   = Math.round(chestScore); details.income    = Math.round(incomeScore);
            details.economy    = Math.round(econScore);  details.trade     = Math.round(tradeScore);
            details.burnRate   = Math.round(burnScore);  details.terminalNet = Math.round(termScore);
            details.mineralPres = Math.round(mineralScore); details.depletion = Math.round(deplScore);
            break;
        }
        case 'boostCapacity': {
            const stockScore   = norm(agg.totalT3Equivalent, CAPS.combatBoosts);
            const tierScore    = agg.t3Ratio * 100;
            const labScore     = norm(agg.totalLabCount, CAPS.labCount * agg.roomCount);
            const minScore     = norm(agg.maxBaseMinerals, CAPS.baseMineralTypes);
            const repScore     = norm(agg.replenishmentRate, CAPS.labCount * 0.8);
            const defBoostScore = norm(agg.totalDefensiveBoosts, 30000);
            score = stockScore * w.stockpile + tierScore * w.tierDistribution + labScore * w.labCapacity +
                    minScore * w.baseMinerals + repScore * w.replenishment + defBoostScore * w.defensiveBoosts;
            details.stockpile = Math.round(stockScore); details.t3Ratio  = Math.round(tierScore);
            details.labs      = Math.round(labScore);   details.minerals = Math.round(minScore);
            details.replenish = Math.round(repScore);   details.defBoosts = Math.round(defBoostScore);
            break;
        }
        case 'defensiveDepth': {
            const repairScore  = norm(agg.theaterRepairPerTick, CAPS.repairPerTick);
            const wallScore    = norm(agg.medianWall, CAPS.wallHPMedian);
            const safeScore    = norm(agg.totalSafeModeTicks, CAPS.safeModeTicks);
            const sustainScore = agg.towerSustainScore * 100;
            const gclScore     = norm(agg.gclHeadroom, 3);
            const rebuildScore = norm(agg.avgStorageEnergy, 500000) * (agg.avgRCL / 8);
            const ctrlScore    = norm(agg.avgDowngrade, 200000);
            score = repairScore * w.repairThroughput + wallScore * w.wallHPPool + safeScore * w.safeModeInventory +
                    sustainScore * w.towerSustain + gclScore * w.gclHeadroom + rebuildScore * w.rebuildCapacity +
                    ctrlScore * w.controllerFort;
            details.repair   = Math.round(repairScore); details.wallHP   = Math.round(wallScore);
            details.safeMode = Math.round(safeScore);   details.towerSustain = Math.round(sustainScore);
            details.gcl      = Math.round(gclScore);    details.rebuild  = Math.round(rebuildScore);
            details.controller = Math.round(ctrlScore);
            break;
        }
        case 'multiFrontStrain': {
            const spawnAllocScore = normInverse(agg.spawnsInTheater / Math.max(1, agg.totalSpawns), 0.7);
            const termBWScore     = agg.terminalNetworkDepth > 0 ? norm(agg.terminalNetworkDepth, 5) : 0;
            const geoScore        = normInverse(agg.geoSpread, CAPS.maxRoomSpread);
            const reserveScore    = norm(agg.reserveRooms, 5);
            const pfRatio         = otherAgg.spawnsInTheater > 0 ? agg.theaterSpawns / otherAgg.spawnsInTheater : 2;
            const pfScore         = norm(pfRatio, 3);
            const strainScore     = normInverse(agg.spawnsInTheater / Math.max(1, agg.totalSpawns), 0.8);
            score = spawnAllocScore * w.spawnAllocation + termBWScore * w.terminalBandwidth +
                    geoScore * w.geoSpread + reserveScore * w.reserveRooms +
                    pfScore * w.perFrontRatio + strainScore * w.ownStrain;
            details.spawnAlloc = Math.round(spawnAllocScore); details.termBW    = Math.round(termBWScore);
            details.geoSpread  = Math.round(geoScore);        details.reserves  = Math.round(reserveScore);
            details.forceRatio = Math.round(pfScore);         details.strain    = Math.round(strainScore);
            break;
        }
    }
    return { score: Math.max(0, Math.min(100, score)), details };
}

function computeWarEstimate(ownRoomData, enemyRoomData) {
    const ownRoomNames   = ownRoomData.map(r => r.room);
    const enemyRoomNames = enemyRoomData.map(r => r.room);
    const ownAgg         = aggregatePlayerData(ownRoomData, enemyRoomNames, ownRoomNames);
    const enemyAgg       = aggregatePlayerData(enemyRoomData, ownRoomNames);

    enemyAgg.gclLevel   = Math.max(enemyAgg.roomCount, Math.round(enemyAgg.avgRCL));
    enemyAgg.gclHeadroom = Math.max(0, enemyAgg.gclLevel - enemyAgg.roomCount);

    const horizons   = ['short', 'medium', 'long'];
    const categories = ['forceProjection', 'spawnThroughput', 'attrition', 'boostCapacity', 'defensiveDepth', 'multiFrontStrain'];
    const categoryLabels = {
        forceProjection: 'Force Projection', spawnThroughput: 'Spawn Throughput',
        attrition: 'Attrition & Sustainability', boostCapacity: 'Boost Capacity',
        defensiveDepth: 'Defensive Depth', multiFrontStrain: 'Multi-Front Strain'
    };

    const results = {};
    for (const h of horizons) {
        results[h] = { categories: {}, overall: { us: 0, them: 0 } };
        for (const cat of categories) {
            const us   = scoreCategoryForSide(cat, h, ownAgg, enemyAgg);
            const them = scoreCategoryForSide(cat, h, enemyAgg, ownAgg);
            const ratio = them.score > 0 ? us.score / them.score : (us.score > 0 ? 99 : 1);
            results[h].categories[cat] = {
                label: categoryLabels[cat], weight: CATEGORY_WEIGHTS[cat],
                us: Math.round(us.score * 10) / 10, them: Math.round(them.score * 10) / 10,
                ratio: Math.round(ratio * 100) / 100,
                usDetails: us.details, themDetails: them.details
            };
            results[h].overall.us   += us.score   * CATEGORY_WEIGHTS[cat];
            results[h].overall.them += them.score * CATEGORY_WEIGHTS[cat];
        }
        results[h].overall.us    = Math.round(results[h].overall.us   * 10) / 10;
        results[h].overall.them  = Math.round(results[h].overall.them * 10) / 10;
        results[h].overall.ratio = results[h].overall.them > 0
            ? Math.round(results[h].overall.us / results[h].overall.them * 100) / 100 : 99;
        results[h].overall.assessment = getAssessment(results[h].overall.ratio);
    }
    return { results, ownAgg, enemyAgg };
}

function getAssessment(ratio) {
    if (ratio > 1.5) return 'FAVORABLE';
    if (ratio > 1.2) return 'SLIGHT EDGE';
    if (ratio >= 0.85) return 'EVEN';
    if (ratio >= 0.65) return 'UNFAVORABLE';
    return 'AVOID';
}
function getAssessmentEmoji(a) {
    return (a === 'FAVORABLE' || a === 'SLIGHT EDGE') ? '🟢' : a === 'EVEN' ? '🟡' : '🔴';
}


// ═══════════════════════════════════════════════════════════════════
// REPORT GENERATION
// ═══════════════════════════════════════════════════════════════════

function formatNumber(num) {
    if (num === undefined || num === null) return '0';
    if (num >= 1000000000) return (num / 1000000000).toFixed(1) + 'B';
    if (num >= 1000000)    return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000)       return (num / 1000).toFixed(1) + 'k';
    return String(Math.round(num));
}

function generateReport(playerName, computeResult, frontLine) {
    const { results, ownAgg, enemyAgg } = computeResult;
    const L = [];

    L.push('⚔️ ' + playerName + ' — ' + enemyAgg.roomCount + ' rooms vs your ' + ownAgg.roomCount);
    L.push('');

    const sR = results.short.overall, mR = results.medium.overall, lR = results.long.overall;
    if (sR.assessment === lR.assessment) {
        L.push(getAssessmentEmoji(sR.assessment) + ' ' + sR.assessment + ' across all horizons (' + sR.ratio.toFixed(1) + ':1)');
    } else {
        L.push(getAssessmentEmoji(sR.assessment) + ' Short: ' + sR.assessment + ' ' + sR.ratio.toFixed(1) + ':1 → ' +
               getAssessmentEmoji(lR.assessment) + ' Long: ' + lR.assessment + ' ' + lR.ratio.toFixed(1) + ':1');
    }
    L.push('');

    const roomRatio  = ownAgg.roomCount / Math.max(1, enemyAgg.roomCount);
    const spawnRatio = enemyAgg.theaterSpawns > 0 ? ownAgg.theaterSpawns / enemyAgg.theaterSpawns : 99;

    if (spawnRatio >= 3)       L.push('You outspawn them ' + ownAgg.theaterSpawns + ' to ' + enemyAgg.theaterSpawns + ' in theater.');
    else if (spawnRatio >= 1.5) L.push('Spawn edge: ' + ownAgg.theaterSpawns + ' vs ' + enemyAgg.theaterSpawns + ' in theater (' + spawnRatio.toFixed(1) + 'x).');
    else if (spawnRatio >= 0.8) L.push('Spawns roughly even in theater: ' + ownAgg.theaterSpawns + ' vs ' + enemyAgg.theaterSpawns + '.');
    else                        L.push('⚠️ They outspawn you in theater: ' + enemyAgg.theaterSpawns + ' vs your ' + ownAgg.theaterSpawns + '.');

    if (ownAgg.ticksToDepletion < 0 && enemyAgg.ticksToDepletion > 0) {
        L.push('Your economy is sustainable. They deplete in ~' + formatNumber(enemyAgg.ticksToDepletion) + ' ticks.');
    } else if (ownAgg.ticksToDepletion > 0 && enemyAgg.ticksToDepletion < 0) {
        L.push('⚠️ You deplete in ~' + formatNumber(ownAgg.ticksToDepletion) + ' ticks. They are sustainable.');
    } else if (ownAgg.ticksToDepletion > 0 && enemyAgg.ticksToDepletion > 0) {
        if (roomRatio >= 3) {
            L.push('Both burn reserves, but your ' + ownAgg.roomCount + '-room economy dwarfs their ' + enemyAgg.roomCount + '.');
        } else if (ownAgg.ticksToDepletion > enemyAgg.ticksToDepletion * 1.5) {
            L.push('Both burn reserves, but they run out first (~' + formatNumber(enemyAgg.ticksToDepletion) + 't vs your ' + formatNumber(ownAgg.ticksToDepletion) + 't).');
        } else if (roomRatio >= 2) {
            L.push('Depletion timers similar, but your ' + ownAgg.roomCount + ' rooms can resupply faster.');
        } else {
            L.push('Both burning reserves at similar rates.');
        }
    } else {
        if (roomRatio >= 3) {
            L.push('Both economies sustainable, but your ' + ownAgg.roomCount + '-room income massively outscales their ' + enemyAgg.roomCount + '.');
        } else if (ownAgg.totalIncome > enemyAgg.totalIncome * 1.5) {
            L.push('Both sustainable, but your income (' + ownAgg.totalIncome.toFixed(0) + '/t) outpaces theirs (' + enemyAgg.totalIncome.toFixed(0) + '/t).');
        }
    }

    if (ownAgg.boostedCreeps > 0 || enemyAgg.boostedCreeps > 0) {
        if (ownAgg.boostedCreeps > 0 && enemyAgg.boostedCreeps === 0)
            L.push('You have ' + ownAgg.boostedCreeps + ' T3 creeps ready. They have none.');
        else if (enemyAgg.boostedCreeps > 0 && ownAgg.boostedCreeps === 0)
            L.push('⚠️ They have ' + enemyAgg.boostedCreeps + ' T3 creeps ready. You have none.');
        else if (ownAgg.boostedCreeps >= enemyAgg.boostedCreeps * 3)
            L.push('Boost edge: ' + ownAgg.boostedCreeps + ' T3 creeps vs their ' + enemyAgg.boostedCreeps + '.');
        else if (enemyAgg.boostedCreeps >= ownAgg.boostedCreeps * 3)
            L.push('⚠️ They outboost you: ' + enemyAgg.boostedCreeps + ' T3 creeps vs your ' + ownAgg.boostedCreeps + '.');
        else
            L.push('Boosts comparable: ' + ownAgg.boostedCreeps + ' vs ' + enemyAgg.boostedCreeps + ' T3 creeps.');
    }

    if (enemyAgg.medianWall > 0 || ownAgg.medianWall > 0) {
        const enemyMin = enemyAgg.weakestWall;
        if (enemyMin > 0 && enemyMin < 10000000)
            L.push('Their weakest breach point is only ' + formatNumber(enemyMin) + '. Vulnerable to focused attack.');
        else if (enemyAgg.medianWall >= 500000000) {
            if (enemyAgg.roomCount <= 2 && roomRatio >= 3)
                L.push('Heavy walls (' + formatNumber(enemyAgg.medianWall) + ' med). Sustained waves drain repair energy.');
            else
                L.push('Strong walls: ' + formatNumber(enemyAgg.medianWall) + ' med, weakest ' + formatNumber(enemyMin) + '.');
        }
    }

    if (frontLine && frontLine.frontLine && frontLine.frontLine.length > 0) {
        const exposed = frontLine.frontLine.slice(0, 3);
        const parts   = exposed.map(r => r.room + ' (' + r.distance + 'r' + (r.entryDir ? ' from ' + r.entryDir : '') + ')');
        L.push('🛡️ Front line: ' + parts.join(', '));
        if (frontLine.frontLine[0].distance <= 2)
            L.push('⚠️ ' + frontLine.frontLine[0].room + ' is only ' + frontLine.frontLine[0].distance + ' room(s) from enemy territory.');
        if (frontLine.unreachable && frontLine.unreachable.length > 0)
            L.push('Safe rear: ' + frontLine.unreachable.join(', '));
    }

    if (enemyAgg.totalSafeModes >= 10)
        L.push('They have ' + enemyAgg.totalSafeModes + ' safe modes — ' + formatNumber(enemyAgg.totalSafeModes * 20000) + ' ticks of stalling.');
    if (ownAgg.nukesCanHitEnemy > 0)
        L.push('You have ' + ownAgg.nukesCanHitEnemy + ' nuker(s) in range.');

    const sCats = results.short.categories, lCats = results.long.categories;
    const attrShift  = lCats.attrition.ratio   - sCats.attrition.ratio;
    const boostShift = lCats.boostCapacity.ratio - sCats.boostCapacity.ratio;
    if (Math.abs(attrShift) > 0.3)
        L.push(attrShift > 0 ? '📈 Attrition tilts your way over time.' : '📉 Attrition tilts against you over time.');
    if (Math.abs(boostShift) > 0.3)
        L.push(boostShift < 0 ? '📉 Your boost advantage fades — use them early.' : '📈 Your boost capacity grows over time.');

    return L;
}

function generateVulnerabilityReport(playerName, enemyData, ownRoomNames) {
    const L = [];
    L.push('');
    L.push('🎯 TARGET PRIORITY');

    function summarizeKills(kills) {
        const counts = {};
        for (const k of kills) counts[k] = (counts[k] || 0) + 1;
        return Object.entries(counts).map(([type, count]) => count > 1 ? count + 'x ' + type : type).join(', ');
    }

    const scored = enemyData.map(r => {
        let vulnScore = 0;
        vulnScore += r.unprotectedCount * 15;
        vulnScore += r.weakProtectedCount * 5;
        if (r.towers <= 2) vulnScore += 10;
        if (r.towers === 0) vulnScore += 20;
        if (r.medianDefenseHits < 1000000)   vulnScore += 15;
        else if (r.medianDefenseHits < 10000000)  vulnScore += 8;
        else if (r.medianDefenseHits < 100000000) vulnScore += 3;
        if (r.safeModeAvailable === 0) vulnScore += 15;
        else if (r.safeModeAvailable <= 1) vulnScore += 5;
        if (r.storageEnergy < 100000) vulnScore += 10;
        else if (r.storageEnergy < 500000) vulnScore += 5;
        if (r.nukeTargets && r.nukeTargets.length > 0)
            vulnScore += Math.min(20, r.nukeTargets[0].priorityScore);
        if (r.nukesToBreachSpawn === 0) vulnScore += 20;
        else if (r.nukesToBreachSpawn <= 2) vulnScore += 10;
        else if (r.nukesToBreachSpawn <= 3) vulnScore += 5;
        const nukersInRange = ownRoomNames.filter(own => canNuke(own, r.room)).length;
        return { ...r, vulnScore, nukersInRange };
    }).sort((a, b) => b.vulnScore - a.vulnScore);

    for (let idx = 0; idx < scored.length; idx++) {
        const r    = scored[idx];
        const tier = r.vulnScore >= 60 ? '🔴' : r.vulnScore >= 35 ? '🟡' : '🟢';

        L.push('');
        L.push(tier + ' #' + (idx + 1) + ' ' + r.room + ' (RCL ' + r.rcl + ')');

        // Defenses & issues
        const issues = [];
        if (r.unprotectedCount > 0) issues.push(r.unprotectedTypes.join(', ') + ' unramparted');
        if (r.towers === 0)        issues.push('no towers');
        else if (r.towers <= 2)    issues.push('only ' + r.towers + ' towers');
        if (r.medianDefenseHits < 10000000 && r.medianDefenseHits > 0)
            issues.push('walls ' + formatNumber(r.medianDefenseHits) + ' med');
        if (r.safeModeAvailable === 0) issues.push('no safe modes');
        if (issues.length > 0) L.push('  ' + issues.join(' · '));
        else L.push('  Well defended: ' + r.towers + 'T, walls ' + formatNumber(r.medianDefenseHits) + ', ' + r.safeModeAvailable + ' safe modes');

        // ── Full 5×5 nuke sweep result ───────────────────────────────
        if (r.bestNukeStrike && r.bestNukeStrike.damage > 0) {
            const ns = r.bestNukeStrike;
            L.push('  💥 Best nuke: (' + ns.x + ',' + ns.y + ') → ' + fmtCr(ns.damage) +
                   ' (' + ns.percent.toFixed(1) + '% of nuke cost)');
            if (ns.destroyedSummary && ns.destroyedSummary !== 'nothing killable')
                L.push('     Kills: ' + ns.destroyedSummary);
        } else {
            L.push('  💥 No profitable nuke target found');
        }

        // Nuke breach / in-range info
        if (r.nukersInRange > 0) {
            if (r.nukesToBreachSpawn === 0 && r.spawns > 0)
                L.push('  🔥 Spawns unramparted — 1 nuke kills spawn');
            else if (r.nukesToBreachSpawn === 1)
                L.push('  🔥 1 nuke breaches spawn (' + formatNumber(r.minCritRampartHP || 0) + ' rampart)');
            else if (r.nukesToBreachSpawn <= 3)
                L.push('  💣 ' + r.nukesToBreachSpawn + ' nukes stacked to breach spawn');
            else
                L.push('  🛡️ Spawn needs ' + r.nukesToBreachSpawn + '+ nukes');

            // Multi-kill cluster from structure-target method (complements sweep)
            if (r.nukeTargets && r.nukeTargets.length > 0) {
                const best = r.nukeTargets[0];
                if (best.killCount > 1)
                    L.push('  Cluster (' + best.x + ',' + best.y + '): kills ' + summarizeKills(best.kills));
            }
            L.push('  ' + r.nukersInRange + ' nuker(s) in range');
        } else {
            L.push('  No nukers in range');
        }
    }

    return L;
}

function generateStrategyReport(results, ownAgg, enemyAgg, enemyData, playerName, frontLine) {
    const L = [];
    L.push('');
    L.push('💡 PLAN');

    const shortA    = results.short.overall.assessment;
    const longA     = results.long.overall.assessment;
    const roomRatio = ownAgg.roomCount / Math.max(1, enemyAgg.roomCount);
    const spawnRatio = enemyAgg.theaterSpawns > 0 ? ownAgg.theaterSpawns / enemyAgg.theaterSpawns : 99;

    if (shortA === 'FAVORABLE' && (longA === 'EVEN' || longA === 'UNFAVORABLE'))
        L.push('Strike now. Your advantage shrinks over time.');
    else if ((shortA === 'EVEN' || shortA === 'UNFAVORABLE') && (longA === 'FAVORABLE' || longA === 'SLIGHT EDGE'))
        L.push('Be patient. Harass and drain — time is your weapon.');
    else if (shortA === 'FAVORABLE' && longA === 'FAVORABLE') {
        if (enemyAgg.roomCount === 1) L.push('Total advantage vs a single room. Siege and collapse.');
        else if (roomRatio >= 3)      L.push('Overwhelming advantage. Pressure multiple rooms simultaneously.');
        else                           L.push('Full advantage. Identify weakest room and commit.');
    } else if (shortA === 'AVOID' || longA === 'AVOID') {
        L.push('Not recommended. Seek allies or alternative targets.');
    } else if (shortA === 'EVEN' && longA === 'EVEN') {
        L.push('Coin flip. Whoever is more active wins.');
    } else {
        if (enemyAgg.roomCount === 1) L.push('They only have 1 room — any sustained pressure is existential.');
        else                           L.push('Mixed. Find their weakest room and concentrate there.');
    }

    if (ownAgg.theaterSpawns > 0 && enemyAgg.roomCount > 1) {
        const enemyPerRoom  = enemyAgg.theaterSpawns > 0 ? enemyAgg.theaterSpawns / enemyAgg.roomCount : 1;
        const optimalFronts = Math.max(1, Math.min(3, Math.floor(ownAgg.theaterSpawns / (enemyPerRoom * 1.5))));
        if (optimalFronts > 1) L.push('Open ' + optimalFronts + ' fronts to split their defense.');
        else                   L.push('Focus on 1 front — not enough spawn margin to split.');
    }

    if (enemyAgg.roomCount === 1) {
        L.push('They have no fallback — losing this room ends them.');
        if (enemyAgg.medianWall >= 500000000)
            L.push('Strong walls but limited repair energy. Sustained waves drain storage faster than 1 room refills.');
    }

    if (spawnRatio >= 3 && enemyAgg.medianWall >= 100000000)
        L.push('You massively outspawn — constant waves force repair drain. Their ' + formatNumber(enemyAgg.warChest) + ' energy won\'t last.');

    if (ownAgg.hasAnyOperator && !enemyAgg.hasAnyOperator)
        L.push('Your operator gives ~30% faster spawning. Sustained creep replacement advantage.');
    else if (!ownAgg.hasAnyOperator && enemyAgg.hasAnyOperator)
        L.push('⚠️ They have operator. Expect faster spawn cycling on defense.');

    if (enemyAgg.reserveRooms > 0 && roomRatio >= 2)
        L.push('Harass their ' + enemyAgg.reserveRooms + ' reserve room(s) to cut remote income.');

    const nukeableRooms = enemyData.filter(r => {
        const inRange = ownAgg.allRoomNames ? ownAgg.allRoomNames.filter(own => canNuke(own, r.room)).length : 0;
        return inRange > 0 && r.nukesToBreachSpawn <= 2;
    });
    if (nukeableRooms.length > 0) {
        L.push('Open with nukes on ' + nukeableRooms.map(r => r.room).join(', ') + ' — spawns breach in ≤2 hits.');
        if (spawnRatio >= 2) L.push('Time conventional attack to land when nukes hit.');
    }

    if (frontLine && frontLine.frontLine && frontLine.frontLine.length > 0) {
        const fl      = frontLine.frontLine;
        const closest = fl[0];
        if (closest.distance <= 2 && closest.entryDir)
            L.push('Fortify ' + closest.room + ' ' + closest.entryDir + ' wall — ' + closest.distance + ' room(s) from enemy.');
        const frontCount = fl.filter(r => r.distance <= closest.distance + 1).length;
        if (frontCount >= 3 && enemyAgg.roomCount >= 3)
            L.push('You have ' + frontCount + ' rooms in striking distance — expect multi-front attacks.');
    }

    if (enemyAgg.totalSafeModes >= 5)
        L.push('Expect ' + enemyAgg.totalSafeModes + ' safe modes (' + formatNumber(enemyAgg.totalSafeModes * 20000) + 't stalling). Plan for a long campaign.');

    return L;
}

function generateTrendsReport(snapshots, playerName, foundRooms) {
    const L = [];
    const roomNames     = Object.keys(snapshots).sort();
    const allFoundRooms = (foundRooms || []).sort();

    if (allFoundRooms.length === 0 && roomNames.length === 0) return L;
    L.push('');
    L.push('📊 ACTIVITY (' + MONITOR_SAMPLES + ' samples / ' + formatNumber(MONITOR_SAMPLES * MONITOR_INTERVAL) + 't)');

    const BOOST_SET       = new Set(ALL_COMBAT_BOOSTS);
    const LAB_PROD_SET    = new Set(LAB_PRODUCTS_LIST);
    const COMMODITY_SET   = new Set([
        'utrium_bar','lemergium_bar','zynthium_bar','keanium_bar','ghodium_melt',
        'oxidant','reductant','purifier','battery','wire','cell','alloy','condensate',
        'switch','phlegm','tube','concentrate','transistor','tissue','fixtures','extract',
        'microchip','muscle','frame','spirit','circuit','organoid','hydraulics','emanation',
        'device','organism','machine','essence','metal','biomass','silicon','mist'
    ]);

    function categorize(res) {
        if (res === RESOURCE_ENERGY) return 'energy';
        if (BOOST_SET.has(res))     return 'combat';
        if (LAB_PROD_SET.has(res))  return 'lab';
        if (COMMODITY_SET.has(res)) return 'commodity';
        return 'base';
    }

    for (const roomName of roomNames) {
        const samples = snapshots[roomName];
        if (samples.length < 2) continue;
        const first = samples[0], last = samples[samples.length - 1];
        const insights = [];

        const boostDelta = last.combatBoosts - first.combatBoosts;
        if (Math.abs(boostDelta) > 1000) {
            const parts = [];
            const aDelta = last.boostAttack - first.boostAttack;
            const rDelta = last.boostRanged - first.boostRanged;
            const hDelta = last.boostHeal   - first.boostHeal;
            const tDelta = last.boostTough  - first.boostTough;
            if (Math.abs(aDelta) > 500) parts.push('atk '  + (aDelta > 0 ? '+' : '') + formatNumber(aDelta));
            if (Math.abs(rDelta) > 500) parts.push('rng '  + (rDelta > 0 ? '+' : '') + formatNumber(rDelta));
            if (Math.abs(hDelta) > 500) parts.push('heal ' + (hDelta > 0 ? '+' : '') + formatNumber(hDelta));
            if (Math.abs(tDelta) > 500) parts.push('tough '+ (tDelta > 0 ? '+' : '') + formatNumber(tDelta));
            insights.push((boostDelta > 0 ? '⚠️ Boosts +' : 'Boosts ') + formatNumber(Math.abs(boostDelta)) + (parts.length > 0 ? ' (' + parts.join(', ') + ')' : ''));
        }

        if (first.nukerG >= 0 && last.nukerG >= 0) {
            const gPct1 = Math.round(first.nukerG / 5000  * 100), gPct2 = Math.round(last.nukerG / 5000  * 100);
            const ePct1 = Math.round(first.nukerE / 300000 * 100), ePct2 = Math.round(last.nukerE / 300000 * 100);
            if (gPct2 === 100 && ePct2 === 100 && (gPct1 < 100 || ePct1 < 100))
                insights.push('⚠️ Nuker ARMED (was ' + gPct1 + '%G ' + ePct1 + '%E)');
            else if (gPct2 > gPct1 || ePct2 > ePct1)
                insights.push('Nuker loading: G ' + gPct1 + '→' + gPct2 + '% E ' + ePct1 + '→' + ePct2 + '%');
        }

        const totalE1 = first.storageE + first.terminalE, totalE2 = last.storageE + last.terminalE;
        const eDelta  = totalE2 - totalE1;
        if (Math.abs(eDelta) > 50000)
            insights.push((eDelta > 0 ? '📈' : '📉') + ' Energy ' + (eDelta > 0 ? '+' : '') + formatNumber(eDelta) + ' (' + formatNumber(totalE2) + ' now)');

        const wallDelta   = last.wallMedHP - first.wallMedHP;
        const wallPctChg  = first.wallMedHP > 0 ? Math.abs(wallDelta) / first.wallMedHP : 0;
        if (wallPctChg > 0.1 && Math.abs(wallDelta) > 500000)
            insights.push(wallDelta > 0 ? '🏗️ Walls +' + formatNumber(wallDelta) + ' med (fortifying)' : 'Walls ' + formatNumber(wallDelta) + ' med');

        const weakDelta = last.weakRamparts - first.weakRamparts;
        if (weakDelta > 0 && last.weakRamparts > 0)
            insights.push('⚠️ ' + last.weakRamparts + ' weak ramparts (<100k) appeared');
        else if (weakDelta < 0 && first.weakRamparts > 0)
            insights.push('Weak ramparts patched: ' + first.weakRamparts + ' → ' + last.weakRamparts);

        for (const p of [{ name: 'spawn', f: 'spawnsProtected' }, { name: 'storage', f: 'storageProtected' }, { name: 'terminal', f: 'terminalProtected' }]) {
            if (last[p.f] < first[p.f])  insights.push('⚠️ ' + p.name + ' lost rampart protection');
            else if (last[p.f] > first[p.f]) insights.push(p.name + ' gained rampart protection');
        }

        if (last.towersEmpty > 0 && first.towersEmpty === 0) insights.push('⚠️ ' + last.towersEmpty + ' tower(s) EMPTY');
        else if (last.towersLow > first.towersLow && last.towersLow > 0) insights.push('Towers low: ' + last.towersLow + '/' + last.towers);

        if (last.activeLabs !== first.activeLabs && last.totalLabs > 0)
            insights.push(last.activeLabs > first.activeLabs
                ? 'Labs spun up: ' + first.activeLabs + ' → ' + last.activeLabs + '/' + last.totalLabs
                : 'Labs idle: '    + first.activeLabs + ' → ' + last.activeLabs + '/' + last.totalLabs);

        const extDelta = last.extFillPct - first.extFillPct;
        if (Math.abs(extDelta) > 10)
            insights.push((extDelta < -20 ? '📉 Extensions ' : extDelta < 0 ? '📉 Extensions ' : '📈 Extensions ') +
                          first.extFillPct + '% → ' + last.extFillPct + '%' + (extDelta < -20 ? ' — logistics failing' : ''));

        if (last.spawns   !== first.spawns)   insights.push((last.spawns   < first.spawns   ? '💥' : '🏗️') + ' Spawns ' + first.spawns   + ' → ' + last.spawns);
        if (last.towers   !== first.towers)   insights.push((last.towers   < first.towers   ? '💥' : '🏗️') + ' Towers ' + first.towers   + ' → ' + last.towers);
        if (last.totalLabs !== first.totalLabs) insights.push((last.totalLabs < first.totalLabs ? '💥' : '🏗️') + ' Labs '   + first.totalLabs + ' → ' + last.totalLabs);
        const rampDelta = last.ramparts - first.ramparts;
        if (Math.abs(rampDelta) > 2) insights.push('Ramparts ' + (rampDelta > 0 ? '+' : '') + rampDelta + ' (' + last.ramparts + ' now)');
        if (last.safeModes < first.safeModes) insights.push('⚠️ Safe mode USED: ' + first.safeModes + ' → ' + last.safeModes);
        if (last.downgradeAlert > 0) insights.push('⚠️ Controller downgrading: ' + formatNumber(last.downgradeAlert) + ' ticks left');
        if (first.psFueled !== null && last.psFueled !== null) {
            if (first.psFueled && !last.psFueled)  insights.push('Power spawn ran dry');
            else if (!first.psFueled && last.psFueled) insights.push('Power spawn refueled');
        }
        const divDelta = last.resourceDiversity - first.resourceDiversity;
        if (Math.abs(divDelta) >= 3)
            insights.push('Resource types: ' + first.resourceDiversity + ' → ' + last.resourceDiversity + (divDelta > 0 ? ' (diversifying)' : ' (simplifying)'));

        // Resource flow (categorized)
        const flow = {}, netDelta = {};
        for (let i = 1; i < samples.length; i++) {
            const prev = samples[i - 1].resources || {}, curr = samples[i].resources || {};
            for (const res of new Set([...Object.keys(prev), ...Object.keys(curr)])) {
                const d = (curr[res] || 0) - (prev[res] || 0);
                if (Math.abs(d) > 100) flow[res] = (flow[res] || 0) + Math.abs(d);
            }
        }
        const firstRes = first.resources || {}, lastRes = last.resources || {};
        for (const res of new Set([...Object.keys(firstRes), ...Object.keys(lastRes)])) {
            const nd = (lastRes[res] || 0) - (firstRes[res] || 0);
            if (Math.abs(nd) > 100) netDelta[res] = nd;
        }
        const catFlow = { combat: 0, lab: 0, commodity: 0, base: 0 };
        const catItems = { combat: [], lab: [], commodity: [], base: [] };
        for (const [res, vol] of Object.entries(flow)) {
            const cat = categorize(res);
            if (cat === 'energy') continue;
            catFlow[cat] += vol;
            catItems[cat].push({ res, vol, net: netDelta[res] || 0 });
        }
        for (const [cat, totalVol] of Object.entries(catFlow).sort((a, b) => b[1] - a[1]).filter(([, v]) => v > 0)) {
            const label = cat === 'combat' ? '⚔️ Combat' : cat === 'lab' ? '🧪 Lab' : cat === 'commodity' ? '📦 Commodity' : '⛏️ Mineral';
            const detail = catItems[cat].sort((a, b) => b.vol - a.vol).slice(0, 3).map(i =>
                i.res + ' ' + formatNumber(i.vol) + ' (' + (i.net >= 0 ? '+' : '') + formatNumber(i.net) + ')'
            ).join(', ');
            insights.push(label + ': ' + detail);
        }

        // Baseline
        const totalEFinal = last.storageE + last.terminalE;
        const baseline = ['E:' + formatNumber(totalEFinal)];
        if (last.combatBoosts > 0) baseline.push('boosts:' + formatNumber(last.combatBoosts));
        if (last.wallMedHP > 0)    baseline.push('wall:' + formatNumber(last.wallMinHP) + '/' + formatNumber(last.wallMedHP));
        baseline.push('labs:' + last.activeLabs + '/' + last.totalLabs, 'ext:' + last.extFillPct + '%');

        let status;
        if (boostDelta > 5000 || (last.nukerG > first.nukerG && last.activeLabs > first.activeLabs)) status = '⚠️ MOBILIZING';
        else if (last.spawns < first.spawns || last.towers < first.towers)                           status = '💥 DAMAGED';
        else if (eDelta < -200000 || (extDelta < -20 && last.extFillPct < 25))                      status = '📉 DECLINING';
        else if (wallDelta > 0 && wallPctChg > 0.1)                                                  status = '🏗️ FORTIFYING';
        else if (insights.length === 0)                                                               status = '➡️ IDLE';
        else                                                                                          status = '📋 ACTIVE';

        L.push('');
        L.push(status + ' ' + roomName + ' [' + baseline.join(' | ') + ']');
        for (const insight of insights) L.push('  ' + insight);
        if (insights.length === 0)
            L.push('  Nothing moved in ' + formatNumber(last.tick - first.tick) + ' ticks — possibly offline.');
    }

    const monitoredSet  = new Set(roomNames);
    const unmonitored   = allFoundRooms.filter(r => !monitoredSet.has(r));
    if (unmonitored.length > 0) {
        L.push('');
        L.push('❌ No observer in range: ' + unmonitored.join(', '));
    }
    return L;
}


// ═══════════════════════════════════════════════════════════════════
// NOTIFICATION SPLITTING  (fixed: accounts for header overhead)
// ═══════════════════════════════════════════════════════════════════

/**
 * Split report lines into notification chunks.
 *
 * Strategy:
 *   1. Reserve NOTIFY_HEADER_MAX chars for the "Part N/M" header.
 *   2. If a single line is longer than the body budget, split it at
 *      the last space before the limit (hard-truncate if no space).
 *   3. Never let a chunk exceed NOTIFY_TOTAL_MAX body chars.
 */
function splitNotifications(lines, playerName) {
    const budget = NOTIFY_TOTAL_MAX; // body chars available per chunk

    // Expand any line longer than budget into sub-lines
    const expanded = [];
    for (const line of lines) {
        if (line.length <= budget) {
            expanded.push(line);
        } else {
            let remaining = line;
            while (remaining.length > budget) {
                let cut = remaining.lastIndexOf(' ', budget);
                if (cut <= 0) cut = budget;
                expanded.push(remaining.slice(0, cut));
                remaining = remaining.slice(cut).trimStart();
            }
            if (remaining.length > 0) expanded.push(remaining);
        }
    }

    // Pack into chunks
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

    const total = chunks.length;
    return chunks.map((body, i) =>
        '[WarEstimate: ' + playerName + '] Part ' + (i + 1) + '/' + total + '\n' + body
    );
}


// ═══════════════════════════════════════════════════════════════════
// ORCHESTRATION
// ═══════════════════════════════════════════════════════════════════

function startWarEstimate(playerName) {
    if (!playerName || typeof playerName !== 'string') {
        console.log('[WarEstimate] Usage: warEstimate("PlayerName")');
        return;
    }
    if (Memory.warEstimate && Memory.warEstimate.active) {
        console.log('[WarEstimate] Estimate already in progress for ' + Memory.warEstimate.targetPlayer + '. Use warEstimateCancel() to cancel.');
        return;
    }
    if (Memory.wideScan && Memory.wideScan.active && Memory.wideScan.targetPlayer !== playerName) {
        console.log('[WarEstimate] wideScan active for ' + Memory.wideScan.targetPlayer + '. Cancel it first.');
        return;
    }

    let enemyRooms = null;
    if (Memory.lastPlayerAnalysis &&
        Memory.lastPlayerAnalysis.player === playerName &&
        Memory.lastPlayerAnalysis.expiresTick > Game.time &&
        Memory.lastPlayerAnalysis.rooms && Memory.lastPlayerAnalysis.rooms.length > 0) {
        enemyRooms = Memory.lastPlayerAnalysis.rooms.map(r => r.room);
        console.log('[WarEstimate] Using cached room list for ' + playerName + ' (' + enemyRooms.length + ' rooms). Skipping discovery.');
    }

    console.log('[WarEstimate] Starting war estimate vs. ' + playerName);

    if (enemyRooms) {
        console.log('[WarEstimate] Phase 1 (discovery): SKIPPED');
        console.log('[WarEstimate] Phase 2 (intel): Scanning ' + enemyRooms.length + ' room(s)...');
        Memory.warEstimate = {
            active: true, phase: 'intel', targetPlayer: playerName,
            startTick: Game.time, foundRooms: enemyRooms.slice(), lastObservedRoom: null,
            intelQueue: enemyRooms.slice(), intelCount: 0, totalIntelRooms: enemyRooms.length, enemyData: [],
            notifyQueue: [], notifySent: 0,
            snapshots: {}, monitorRound: 0, monitorNextTick: 0, monitorScanQueue: [], monitorPendingRooms: []
        };
    } else {
        console.log('[WarEstimate] Phase 1 (discovery): Launching wideScan...');
        wideScan.start(playerName);
        Memory.warEstimate = {
            active: true, phase: 'discovery', targetPlayer: playerName,
            startTick: Game.time, foundRooms: [], lastObservedRoom: null,
            intelQueue: [], intelCount: 0, totalIntelRooms: 0, enemyData: [],
            notifyQueue: [], notifySent: 0,
            snapshots: {}, monitorRound: 0, monitorNextTick: 0, monitorScanQueue: [], monitorPendingRooms: []
        };
    }
}

function cancelWarEstimate() {
    if (Memory.warEstimate && Memory.warEstimate.active) {
        if (Memory.warEstimate.phase === 'discovery' && Memory.wideScan && Memory.wideScan.active)
            wideScan.cancel();
        console.log('[WarEstimate] Cancelled.');
        delete Memory.warEstimate;
    } else {
        console.log('[WarEstimate] No active estimate.');
    }
}

function getWarEstimateStatus() {
    if (!Memory.warEstimate || !Memory.warEstimate.active) {
        console.log('[WarEstimate] No active estimate.');
        return null;
    }
    const s = Memory.warEstimate;
    console.log('[WarEstimate] Target: ' + s.targetPlayer + ' | Phase: ' + s.phase);
    if (s.phase === 'discovery' && Memory.wideScan && Memory.wideScan.active) {
        const pct = ((Memory.wideScan.scannedCount / Memory.wideScan.totalRooms) * 100).toFixed(1);
        console.log('[WarEstimate] Discovery: ' + Memory.wideScan.scannedCount + '/' + Memory.wideScan.totalRooms + ' (' + pct + '%) — ' + (Memory.wideScan.foundRooms || []).length + ' found');
    } else if (s.phase === 'intel') {
        console.log('[WarEstimate] Intel: ' + s.intelCount + '/' + s.totalIntelRooms);
    } else if (s.phase === 'monitoring') {
        const ticksLeft = s.monitorNextTick ? Math.max(0, s.monitorNextTick - Game.time) : 0;
        console.log('[WarEstimate] Monitoring: sample ' + s.monitorRound + '/' + MONITOR_SAMPLES + ' | Next in ' + ticksLeft + ' ticks');
    } else if (s.phase === 'notifying') {
        console.log('[WarEstimate] Notifying: ' + s.notifySent + '/' + (s.notifyQueue ? s.notifyQueue.length : 0));
    }
    console.log('[WarEstimate] Elapsed: ' + (Game.time - s.startTick) + ' ticks');
    return s;
}

function getLastWarEstimate() {
    if (!Memory.lastWarEstimate) { console.log('[WarEstimate] No previous estimate.'); return null; }
    if (Memory.lastWarEstimate.expiresTick <= Game.time) {
        console.log('[WarEstimate] Previous estimate expired.');
        delete Memory.lastWarEstimate; return null;
    }
    console.log(Memory.lastWarEstimate.reportText);
    return Memory.lastWarEstimate;
}

function run() {
    if (Memory.lastWarEstimate && Memory.lastWarEstimate.expiresTick <= Game.time)
        delete Memory.lastWarEstimate;

    if (!Memory.warEstimate || !Memory.warEstimate.active) return;
    const state = Memory.warEstimate;

    if (state.phase === 'discovery')  runDiscoveryPhase(state);
    else if (state.phase === 'intel') { const om = getMyObservers(); runIntelPhase(state, om); }
    else if (state.phase === 'monitoring') { const om = getMyObservers(); runMonitoringPhase(state, om); }
    else if (state.phase === 'computing')  runComputePhase(state);
    else if (state.phase === 'notifying')  runNotifyPhase(state);
}

function runDiscoveryPhase(state) {
    if (Memory.wideScan && Memory.wideScan.active) {
        state.foundRooms = (Memory.wideScan.foundRooms || []).slice();
        return;
    }
    console.log('[WarEstimate] Phase 1 (discovery) complete. Found ' + state.foundRooms.length + ' room(s).');
    if (state.foundRooms.length === 0) {
        console.log('[WarEstimate] No rooms found for ' + state.targetPlayer + '. Aborting.');
        Game.notify('[WarEstimate] ' + state.targetPlayer + ': No rooms found in observer range.', 0);
        delete Memory.warEstimate; return;
    }
    state.phase = 'intel';
    state.intelQueue = state.foundRooms.slice();
    state.totalIntelRooms = state.foundRooms.length;
    console.log('[WarEstimate] Phase 2 (intel): Scanning ' + state.totalIntelRooms + ' room(s)...');
}

function runIntelPhase(state, observerMap) {
    if (state.lastObservedRoom) {
        const room = Game.rooms[state.lastObservedRoom];
        if (room) state.enemyData.push(gatherRoomWarData(room));
        state.intelCount++;
        state.lastObservedRoom = null;
    }

    if (state.intelQueue.length === 0) {
        console.log('[WarEstimate] Phase 2 (intel) complete. ' + state.enemyData.length + '/' + state.totalIntelRooms + ' rooms gathered.');
        state.phase = 'monitoring';
        state.monitorRound = 0; state.monitorNextTick = Game.time;
        state.monitorScanQueue = []; state.monitorPendingRooms = [];
        const estMin = Math.ceil((MONITOR_SAMPLES * MONITOR_INTERVAL * 3) / 60);
        console.log('[WarEstimate] Phase 3 (monitoring): ' + MONITOR_SAMPLES + ' samples (~' + estMin + ' min)');
        Game.notify('[WarEstimate] ' + state.targetPlayer + ': Intel done, monitoring ' + state.foundRooms.length + ' room(s). Report incoming.', 0);
        return;
    }

    const nextRoom = state.intelQueue.shift();
    const observer = findObserverForRoom(nextRoom, observerMap);
    if (observer) {
        const result = observer.observeRoom(nextRoom);
        if (result === OK) state.lastObservedRoom = nextRoom;
        else { console.log('[WarEstimate] observeRoom ' + nextRoom + ' returned ' + result); state.intelCount++; }
    } else {
        console.log('[WarEstimate] No observer in range of ' + nextRoom);
        state.intelCount++;
    }
}

function runMonitoringPhase(state, observerMap) {
    if (state.monitorPendingRooms && state.monitorPendingRooms.length > 0) {
        for (const roomName of state.monitorPendingRooms) {
            const room = Game.rooms[roomName];
            if (room) {
                if (!state.snapshots[roomName]) state.snapshots[roomName] = [];
                state.snapshots[roomName].push(gatherSnapshot(room));
            }
        }
        state.monitorPendingRooms = [];
    }

    if (state.monitorScanQueue && state.monitorScanQueue.length > 0) {
        const usedObservers = new Set(), observed = [], remaining = [], noObserver = [];
        const roomCandidates = state.monitorScanQueue.map(r => ({ room: r, observers: findAllObserversForRoom(r, observerMap) }));
        roomCandidates.sort((a, b) => a.observers.length - b.observers.length);
        for (const { room, observers } of roomCandidates) {
            if (observers.length === 0) { noObserver.push(room); continue; }
            const available = observers.find(o => !usedObservers.has(o.id));
            if (available) {
                if (available.observeRoom(room) === OK) { usedObservers.add(available.id); observed.push(room); }
                else remaining.push(room);
            } else { remaining.push(room); }
        }
        if (noObserver.length > 0 && state.monitorRound === 1)
            console.log('[WarEstimate] No observer for: ' + noObserver.join(', '));
        state.monitorPendingRooms = observed;
        state.monitorScanQueue    = remaining;
        return;
    }

    if (state.monitorScanQueue && state.monitorScanQueue.length === 0 && state.monitorRound > 0) {
        state.monitorNextTick = Game.time + MONITOR_INTERVAL;
        state.monitorScanQueue = null;
    }

    if (state.monitorRound >= MONITOR_SAMPLES) {
        console.log('[WarEstimate] Phase 3 (monitoring) complete.');
        state.phase = 'computing'; return;
    }

    if (state.monitorNextTick && Game.time < state.monitorNextTick) return;

    state.monitorRound++;
    state.monitorScanQueue = state.foundRooms.slice();
    if (state.monitorRound % 3 === 0 || state.monitorRound === 1)
        console.log('[WarEstimate] Monitoring sample ' + state.monitorRound + '/' + MONITOR_SAMPLES);
}

function runComputePhase(state) {
    console.log('[WarEstimate] Computing war estimate...');
    const ownData      = gatherOwnData();
    const ownRoomNames = ownData.map(r => r.room);
    console.log('[WarEstimate] Own: ' + ownData.length + ' | Enemy: ' + state.enemyData.length);

    if (state.enemyData.length === 0) {
        console.log('[WarEstimate] No enemy data gathered. Aborting.');
        delete Memory.warEstimate; return;
    }

    const computeResult = computeWarEstimate(ownData, state.enemyData);
    const frontLine     = findFrontLine(state.foundRooms, ownRoomNames, state.targetPlayer);

    const mainReport   = generateReport(state.targetPlayer, computeResult, frontLine);
    const vulnReport   = generateVulnerabilityReport(state.targetPlayer, state.enemyData, ownRoomNames);
    const trendsReport = generateTrendsReport(state.snapshots, state.targetPlayer, state.foundRooms);
    const stratReport  = generateStrategyReport(computeResult.results, computeResult.ownAgg, computeResult.enemyAgg, state.enemyData, state.targetPlayer, frontLine);
    const allLines     = [...mainReport, ...vulnReport, ...trendsReport, ...stratReport];

    const reportText = allLines.join('\n');
    console.log(reportText);

    const enemyRoomCount = state.enemyData.length;
    delete state.snapshots;
    delete state.enemyData;

    state.notifyQueue = splitNotifications(allLines, state.targetPlayer);
    state.notifySent  = 0;
    state.phase       = 'notifying';

    Memory.lastWarEstimate = {
        player: state.targetPlayer, tick: Game.time,
        expiresTick: Game.time + 2000, reportText,
        ownRooms: ownData.length, enemyRooms: enemyRoomCount
    };

    console.log('[WarEstimate] Sending ' + state.notifyQueue.length + ' notification(s)...');
}

function runNotifyPhase(state) {
    const toSend = Math.min(NOTIFY_PER_TICK, state.notifyQueue.length - state.notifySent);
    for (let i = 0; i < toSend; i++) {
        Game.notify(state.notifyQueue[state.notifySent], 0);
        state.notifySent++;
    }
    if (state.notifySent >= state.notifyQueue.length) {
        console.log('[WarEstimate] All ' + state.notifySent + ' notification(s) sent. Done (' + (Game.time - state.startTick) + ' ticks total).');
        delete Memory.warEstimate;
    }
}


// ═══════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════

module.exports = {
    start:  startWarEstimate,
    run:    run,
    cancel: cancelWarEstimate,
    status: getWarEstimateStatus,
    last:   getLastWarEstimate
};

global.warEstimate       = startWarEstimate;
global.warEstimateCancel = cancelWarEstimate;
global.warEstimateStatus = getWarEstimateStatus;
global.warEstimateLast   = getLastWarEstimate;