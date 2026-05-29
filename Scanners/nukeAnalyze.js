/**
 * Nuke Analysis Module
 *
 * Console commands:
 *   nukeAnalyze('ROOM_NAME' [, N])  - Find the best N nuke strike positions
 *                                    using greedy simulation (each strike accounts
 *                                    for damage already dealt). N defaults to 1.
 *                                    Uses observer / PWR_OPERATE_OBSERVER if the
 *                                    room is not visible; auto-completes next tick.
 *
 *   nukeAnalyzeSelf()               - Run nukeAnalyze on every room you own and
 *                                     print a compact summary. No observer needed.
 *
 *   nukeAnalyzeCost('ROOM', x, y)         - Single strike: show replacement cost,
 *   nukeAnalyzeCost('ROOM', [{x,y}, ...]) - Multi strike: automatically stacks
 *                                           damage from all simultaneous nukes
 *                                           per tile before checking rampart HP.
 *                                           nukeIncoming() calls this form
 *                                           internally — no extra global needed.
 *                                     Uses observer fallback if room not visible;
 *                                     auto-completes when room becomes visible.
 *
 *   nukeIncoming(['ROOM_NAME'])      - Scan owned room(s) for incoming nukes using
 *                                     FIND_NUKES, then auto-run nukeAnalyzeCost for
 *                                     ALL landing positions at once so stacked tile
 *                                     damage is correctly accounted for.
 *                                     Optional room argument limits scan to one room.
 *                                     Uses observer / PWR_OPERATE_OBSERVER if room
 *                                     is not visible; auto-completes next tick.
 *                                     Examples:
 *                                       nukeIncoming()          — all owned rooms
 *                                       nukeIncoming('W1N46')   — one room only
 *
 *   nukeThreat('ROOM_NAME')          - Scan all rooms within OBSERVER_RANGE of the
 *                                     target, determine which hostile (non‑whitelisted)
 *                                     player has the most operational nukers in range,
 *                                     and test whether that many nukes could destroy
 *                                     all spawns + terminal + storage if optimally placed.
 *                                     Uses observer fallback; auto‑completes progressively.
 *
 *   nukeThreatStatus('ROOM_NAME')    - Show progress of an active threat scan.
 *
 * Finds the optimal 5x5 nuke strike position to maximise economic damage.
 * Accounts for:
 *  - 10M direct hit (center) / 5M area damage (range 1-2)
 *  - Rampart HP vs nuke damage: full shield or forced repair cost
 *  - Structure construction cost (energy x market price via marketBuy)
 *  - Stored resources (each resource at market buy price via marketBuy)
 *  - Nuke cost (300k energy + 5000 Ghodium, both at market buy price)
 *
 * Observer fallback chain (nukeAnalyze / nukeAnalyzeCost / nukeIncoming / nukeThreat):
 *   1. Structural observer within 10 rooms (auto-completes next tick)
 *   2. Operator with PWR_OPERATE_OBSERVER (~3 tick delay)
 *   3. Manual scout required
 *
 * Add to main.js:
 *   const nukeAnalyzeModule = require('nukeAnalyze');
 *   global.nukeAnalyze     = nukeAnalyzeModule.nukeAnalyze;
 *   global.nukeAnalyzeSelf = nukeAnalyzeModule.nukeAnalyzeSelf;
 *   global.nukeAnalyzeCost = nukeAnalyzeModule.nukeAnalyzeCost;
 *   global.nukeIncoming    = nukeAnalyzeModule.nukeIncoming;
 *   global.nukeThreat      = nukeAnalyzeModule.nukeThreat;
 *   global.nukeThreatStatus = nukeAnalyzeModule.nukeThreatStatus;
 *   // In main loop (runs every tick):
 *   nukeAnalyzeModule.processPendingNukeAnalyze();
 */

'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────

const NUKE_DIRECT_DAMAGE     = 10000000;
const NUKE_AREA_DAMAGE       =  5000000;
const NUKE_ENERGY_COST       =   300000;
const NUKE_GHODIUM_COST      =     5000;
const OBSERVER_RANGE         =       10;
const REPAIR_HITS_PER_ENERGY =      100;

const BUILD_COST = {
    spawn:          15000,
    extension:       3000,
    road:             300,
    wall:               1,
    rampart:            1,
    link:            5000,
    storage:        30000,
    tower:           5000,
    observer:        8000,
    powerSpawn:    100000,
    extractor:       5000,
    lab:            50000,
    terminal:      100000,
    container:       5000,
    nuker:         100000,
    factory:       100000
};

// ─── IFF integration (whitelist determines "friendly") ───────────────────────
//
// FIX #11: Don't mutate the imported module. Use a local wrapper function so
// other modules that require('iff') continue to see the original object.
//
let iff;
let isFriendlyUsername;
try {
    iff = require('iff');
    isFriendlyUsername = (iff && typeof iff.isFriendlyUsername === 'function')
        ? function(u) { return iff.isFriendlyUsername(u); }
        : function() { return false; };
} catch (e) {
    iff = {};
    isFriendlyUsername = function() { return false; };
}

// ─── Market helpers ───────────────────────────────────────────────────────────

function getMarketBuyPrice(resource) {
    try {
        var marketBuyer = require('marketBuy');
        if (marketBuyer && typeof marketBuyer.computeBuyPrice === 'function') {
            return marketBuyer.computeBuyPrice(resource);
        }
    } catch (e) {}
    try {
        // FIX #4: Use ORDER_SELL + Math.min to get the actual buy price (the
        // lowest price you'd have to pay), not the highest ORDER_BUY bid
        // (which is the liquidation / sell-side value).
        var orders = Game.market.getAllOrders({ type: ORDER_SELL, resourceType: resource });
        if (!orders || orders.length === 0) return 0;
        return Math.min.apply(null, orders.map(function(o) { return o.price; }));
    } catch (e) {
        return 0;
    }
}

function buildPriceCache(room) {
    const cache = {};
    function addFromStore(store) {
        if (!store) return;
        for (var res in store) {
            if (cache[res] === undefined) cache[res] = getMarketBuyPrice(res);
        }
    }
    var allStructures = room.find(FIND_STRUCTURES);
    for (var i = 0; i < allStructures.length; i++) addFromStore(allStructures[i].store);
    if (cache[RESOURCE_ENERGY]  === undefined) cache[RESOURCE_ENERGY]  = getMarketBuyPrice(RESOURCE_ENERGY);
    if (cache[RESOURCE_GHODIUM] === undefined) cache[RESOURCE_GHODIUM] = getMarketBuyPrice(RESOURCE_GHODIUM);
    return cache;
}

// ─── Damage value helpers ─────────────────────────────────────────────────────

function structureDestroyValue(structure, priceCache) {
    var type        = structure.structureType;
    var buildCost   = (BUILD_COST[type] || 0) * (priceCache[RESOURCE_ENERGY] || 0);
    var storedValue = 0;
    if (structure.store) {
        for (var res in structure.store) {
            var amount = structure.store[res] || 0;
            if (amount <= 0) continue;
            var price = priceCache[res] !== undefined ? priceCache[res] : getMarketBuyPrice(res);
            storedValue += amount * price;
        }
    }
    return { buildCost: buildCost, storedValue: storedValue, total: buildCost + storedValue };
}

function rampartDestroyValue(rampart, energyPrice) {
    return (rampart.hits / REPAIR_HITS_PER_ENERGY) * energyPrice;
}

function rampartRepairCost(nukeHits, energyPrice) {
    return (nukeHits / REPAIR_HITS_PER_ENERGY) * energyPrice;
}

// ─── Strike analyser (used by nukeAnalyze / nukeAnalyzeSelf) ─────────────────

function analyzeStrike(cx, cy, structureMap, priceCache) {
    var energyPrice  = priceCache[RESOURCE_ENERGY] || 0;
    var totalCredits = 0;
    var destroyed    = [];
    var shielded     = [];
    var rampartsHit  = [];

    for (var dx = -2; dx <= 2; dx++) {
        for (var dy = -2; dy <= 2; dy++) {
            var x = cx + dx;
            var y = cy + dy;
            if (x < 0 || x > 49 || y < 0 || y > 49) continue;

            var nukeHits = (dx === 0 && dy === 0) ? NUKE_DIRECT_DAMAGE : NUKE_AREA_DAMAGE;
            var key      = x + ',' + y;
            var structs  = structureMap[key];
            if (!structs || structs.length === 0) continue;

            var ramparts  = [];
            var buildings = [];
            for (var i = 0; i < structs.length; i++) {
                var s = structs[i];
                // FIX #12: Controllers can't be destroyed by nukes; exclude them.
                if (s.structureType === STRUCTURE_CONTROLLER) continue;
                if (s.structureType === STRUCTURE_RAMPART) {
                    ramparts.push(s);
                } else if (s.structureType !== STRUCTURE_ROAD && s.structureType !== STRUCTURE_WALL) {
                    buildings.push(s);
                }
            }

            var bestRampart = null;
            for (var r = 0; r < ramparts.length; r++) {
                if (!bestRampart || ramparts[r].hits > bestRampart.hits) bestRampart = ramparts[r];
            }

            var rampartBlocks = bestRampart && (bestRampart.hits > nukeHits);

            for (var b = 0; b < buildings.length; b++) {
                var bld = buildings[b];
                if (rampartBlocks) {
                    shielded.push({ x: x, y: y, type: bld.structureType });
                } else {
                    var val = structureDestroyValue(bld, priceCache);
                    totalCredits += val.total;
                    destroyed.push({ x: x, y: y, type: bld.structureType, value: val.total, storedValue: val.storedValue });
                }
            }

            if (bestRampart) {
                if (!rampartBlocks) {
                    var rVal = rampartDestroyValue(bestRampart, energyPrice);
                    totalCredits += rVal;
                    destroyed.push({ x: x, y: y, type: STRUCTURE_RAMPART, value: rVal, storedValue: 0, hits: bestRampart.hits });
                } else {
                    var rCost = rampartRepairCost(nukeHits, energyPrice);
                    totalCredits += rCost;
                    rampartsHit.push({ x: x, y: y, hits: bestRampart.hits, damage: nukeHits, repairCost: rCost });
                }
            }
        }
    }

    return { totalCredits: totalCredits, destroyed: destroyed, shielded: shielded, rampartsHit: rampartsHit };
}

// ─── Multi-nuke simulation state ─────────────────────────────────────────────

function buildSimState(room) {
    var simState      = {};
    var allStructures = room.find(FIND_STRUCTURES);
    for (var i = 0; i < allStructures.length; i++) {
        var s   = allStructures[i];
        // FIX #12: Skip controllers — nukes can't destroy them and they have
        // BUILD_COST = 0, which pollutes the destroyed[] list with $0 entries.
        if (s.structureType === STRUCTURE_CONTROLLER) continue;
        var key = s.pos.x + ',' + s.pos.y;
        if (!simState[key]) simState[key] = [];
        var storeCopy = {};
        if (s.store) { for (var res in s.store) storeCopy[res] = s.store[res]; }
        simState[key].push({ structureType: s.structureType, hits: s.hits, store: storeCopy, destroyed: false });
    }
    return simState;
}

function simulateStrike(cx, cy, simState, priceCache) {
    var energyPrice  = priceCache[RESOURCE_ENERGY] || 0;
    var totalCredits = 0;
    var destroyed    = [];
    var shielded     = [];
    var rampartsHit  = [];

    for (var dx = -2; dx <= 2; dx++) {
        for (var dy = -2; dy <= 2; dy++) {
            var x = cx + dx;
            var y = cy + dy;
            if (x < 0 || x > 49 || y < 0 || y > 49) continue;

            var nukeHits = (dx === 0 && dy === 0) ? NUKE_DIRECT_DAMAGE : NUKE_AREA_DAMAGE;
            var key      = x + ',' + y;
            var entries  = simState[key];
            if (!entries || entries.length === 0) continue;

            var bestRampart = null;
            var buildings   = [];
            for (var i = 0; i < entries.length; i++) {
                var e = entries[i];
                if (e.destroyed) continue;
                if (e.structureType === STRUCTURE_RAMPART) {
                    if (!bestRampart || e.hits > bestRampart.hits) bestRampart = e;
                } else if (e.structureType !== STRUCTURE_ROAD && e.structureType !== STRUCTURE_WALL) {
                    buildings.push(e);
                }
            }

            var rampartBlocks = bestRampart && (bestRampart.hits > nukeHits);

            for (var b = 0; b < buildings.length; b++) {
                var bld = buildings[b];
                if (rampartBlocks) {
                    shielded.push({ x: x, y: y, type: bld.structureType });
                } else {
                    var buildCost   = (BUILD_COST[bld.structureType] || 0) * energyPrice;
                    var storedValue = 0;
                    for (var res in bld.store) {
                        var amt = bld.store[res] || 0;
                        if (amt <= 0) continue;
                        var price = priceCache[res] !== undefined ? priceCache[res] : getMarketBuyPrice(res);
                        storedValue += amt * price;
                    }
                    var total = buildCost + storedValue;
                    totalCredits += total;
                    destroyed.push({ x: x, y: y, type: bld.structureType, value: total, storedValue: storedValue });
                    bld.destroyed = true;
                }
            }

            if (bestRampart) {
                if (!rampartBlocks) {
                    var rVal = (bestRampart.hits / REPAIR_HITS_PER_ENERGY) * energyPrice;
                    totalCredits += rVal;
                    destroyed.push({ x: x, y: y, type: STRUCTURE_RAMPART, value: rVal, storedValue: 0, hits: bestRampart.hits });
                    bestRampart.destroyed = true;
                    bestRampart.hits      = 0;
                } else {
                    var rCost = (nukeHits / REPAIR_HITS_PER_ENERGY) * energyPrice;
                    totalCredits += rCost;
                    rampartsHit.push({ x: x, y: y, hits: bestRampart.hits, damage: nukeHits, repairCost: rCost });
                    bestRampart.hits -= nukeHits;
                }
            }
        }
    }

    return { totalCredits: totalCredits, destroyed: destroyed, shielded: shielded, rampartsHit: rampartsHit };
}

function findBestStrike(simState, priceCache) {
    var best = { totalCredits: 0, destroyed: [], shielded: [], rampartsHit: [], cx: 25, cy: 25 };
    for (var cx = 2; cx <= 47; cx++) {
        for (var cy = 2; cy <= 47; cy++) {
            var result = previewStrike(cx, cy, simState, priceCache);
            if (result.totalCredits > best.totalCredits) { best = result; best.cx = cx; best.cy = cy; }
        }
    }
    return best;
}

function previewStrike(cx, cy, simState, priceCache) {
    var energyPrice  = priceCache[RESOURCE_ENERGY] || 0;
    var totalCredits = 0;
    var destroyed    = [];
    var shielded     = [];
    var rampartsHit  = [];

    for (var dx = -2; dx <= 2; dx++) {
        for (var dy = -2; dy <= 2; dy++) {
            var x = cx + dx;
            var y = cy + dy;
            if (x < 0 || x > 49 || y < 0 || y > 49) continue;

            var nukeHits = (dx === 0 && dy === 0) ? NUKE_DIRECT_DAMAGE : NUKE_AREA_DAMAGE;
            var key      = x + ',' + y;
            var entries  = simState[key];
            if (!entries || entries.length === 0) continue;

            var bestRampart = null;
            var buildings   = [];
            for (var i = 0; i < entries.length; i++) {
                var e = entries[i];
                if (e.destroyed) continue;
                if (e.structureType === STRUCTURE_RAMPART) {
                    if (!bestRampart || e.hits > bestRampart.hits) bestRampart = e;
                } else if (e.structureType !== STRUCTURE_ROAD && e.structureType !== STRUCTURE_WALL) {
                    buildings.push(e);
                }
            }

            var rampartBlocks = bestRampart && (bestRampart.hits > nukeHits);

            for (var b = 0; b < buildings.length; b++) {
                var bld = buildings[b];
                if (rampartBlocks) {
                    shielded.push({ x: x, y: y, type: bld.structureType });
                } else {
                    var buildCost   = (BUILD_COST[bld.structureType] || 0) * energyPrice;
                    var storedValue = 0;
                    for (var res in bld.store) {
                        var amt = bld.store[res] || 0;
                        if (amt <= 0) continue;
                        var price = priceCache[res] !== undefined ? priceCache[res] : getMarketBuyPrice(res);
                        storedValue += amt * price;
                    }
                    var total = buildCost + storedValue;
                    totalCredits += total;
                    destroyed.push({ x: x, y: y, type: bld.structureType, value: total, storedValue: storedValue });
                }
            }

            if (bestRampart) {
                if (!rampartBlocks) {
                    var rVal = (bestRampart.hits / REPAIR_HITS_PER_ENERGY) * energyPrice;
                    totalCredits += rVal;
                    destroyed.push({ x: x, y: y, type: STRUCTURE_RAMPART, value: rVal, storedValue: 0, hits: bestRampart.hits });
                } else {
                    var rCost = (nukeHits / REPAIR_HITS_PER_ENERGY) * energyPrice;
                    totalCredits += rCost;
                    rampartsHit.push({ x: x, y: y, hits: bestRampart.hits, damage: nukeHits, repairCost: rCost });
                }
            }
        }
    }

    return { totalCredits: totalCredits, destroyed: destroyed, shielded: shielded, rampartsHit: rampartsHit };
}

// ─── Observer helpers ─────────────────────────────────────────────────────────

function parseRoomCoords(roomName) {
    var m = roomName.match(/^([WE])(\d+)([NS])(\d+)$/);
    if (!m) return null;
    var x = parseInt(m[2], 10);
    var y = parseInt(m[4], 10);
    if (m[1] === 'W') x = -x - 1;
    if (m[3] === 'S') y = -y - 1;
    return { x: x, y: y };
}

// Generate all room names within a Chebyshev distance from centerRoom
function roomsInRange(centerRoom, range) {
    const coords = parseRoomCoords(centerRoom);
    if (!coords) return [];
    const rooms = [];
    for (let dx = -range; dx <= range; dx++) {
        for (let dy = -range; dy <= range; dy++) {
            const x = coords.x + dx;
            const y = coords.y + dy;
            let h = x < 0 ? 'W' + (-x - 1) : 'E' + x;
            let v = y < 0 ? 'S' + (-y - 1) : 'N' + y;
            rooms.push(h + v);
        }
    }
    return rooms;
}

function findObserverInRange(targetRoomName) {
    var tc = parseRoomCoords(targetRoomName);
    if (!tc) return null;
    var best = null, bestDist = Infinity;
    for (var roomName in Game.rooms) {
        var room = Game.rooms[roomName];
        if (!room.controller || !room.controller.my) continue;
        var observers = room.find(FIND_STRUCTURES, { filter: function(s) { return s.structureType === STRUCTURE_OBSERVER; } });
        for (var i = 0; i < observers.length; i++) {
            var oc = parseRoomCoords(roomName);
            if (!oc) continue;
            var dist = Math.max(Math.abs(tc.x - oc.x), Math.abs(tc.y - oc.y));
            if (dist <= OBSERVER_RANGE && dist < bestDist) { best = observers[i]; bestDist = dist; }
        }
    }
    return best;
}

// Helper: try to observe a room with one available observer (checks Set to avoid double‑booking)
function tryObserveRoom(roomName, usedObservers) {
    const observer = findObserverInRange(roomName);
    if (!observer || usedObservers.has(observer.id)) return false;
    const result = observer.observeRoom(roomName);
    if (result === OK) {
        usedObservers.add(observer.id);
        return true;
    }
    return false;
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmt(n) {
    if (n === undefined || n === null || isNaN(n)) return '0 cr';
    if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M cr';
    if (n >= 1000)    return (n / 1000).toFixed(1) + 'k cr';
    return Math.round(n) + ' cr';
}

// FIX #7: Use one decimal place in the thousands range so that e.g. 1500
// renders as "1.5k" instead of rounding to "2k".
function fmtNum(n) {
    if (!n) return '0';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000)    return (n / 1000).toFixed(1) + 'k';
    return String(n);
}

// ─── nukeAnalyze ─────────────────────────────────────────────────────────────

function nukeAnalyze(roomName, numNukes) {
    if (!roomName || typeof roomName !== 'string') {
        console.log('[NukeAnalyze] Usage: nukeAnalyze("W1N1") or nukeAnalyze("W1N1", 3)');
        return null;
    }
    numNukes = (typeof numNukes === 'number' && numNukes >= 1) ? Math.floor(numNukes) : 1;

    if (!Memory.nukeAnalyzePending) Memory.nukeAnalyzePending = {};
    if (!Memory.intelPowerObserve)  Memory.intelPowerObserve  = {};

    var room = Game.rooms[roomName];

    if (!room) {
        var pending = Memory.nukeAnalyzePending[roomName];

        // FIX #5: The original condition (<= 1) fired during the legitimate
        // observation window (the observer's effect lands at tick N+1, so a
        // retry on that tick would incorrectly report failure).  We now only
        // trigger the hard-fail path when MORE than 1 tick has elapsed without
        // visibility, and we skip it entirely for powered-observer requests
        // (which legitimately take several ticks).
        if (pending && !pending.costMode && !pending.poweredObserver &&
                Game.time - pending.tick > 1) {
            console.log('[NukeAnalyze] ERROR: ' + roomName + ' still not visible after observation attempt.');
            delete Memory.nukeAnalyzePending[roomName];
            return null;
        }

        var poKey = roomName;
        if (Memory.intelPowerObserve[poKey]) {
            var req = Memory.intelPowerObserve[poKey];
            if (Game.time - req.tick <= 50) {
                console.log('[NukeAnalyze] ⏳ PWR_OPERATE_OBSERVER in progress — operator: ' + req.operatorName + ', elapsed: ' + (Game.time - req.tick) + ' ticks.');
                return { status: 'pending_power_observe', room: roomName };
            }
            delete Memory.intelPowerObserve[poKey];
        }

        var observer = findObserverInRange(roomName);
        if (observer) {
            var obsResult = observer.observeRoom(roomName);
            if (obsResult === OK) {
                Memory.nukeAnalyzePending[roomName] = { tick: Game.time, observerRoom: observer.room.name, numNukes: numNukes };
                console.log('[NukeAnalyze] 🔭 Observing ' + roomName + ' via observer in ' + observer.room.name + '. Run nukeAnalyze(\'' + roomName + '\') next tick.');
                return { status: 'pending', room: roomName, observerRoom: observer.room.name };
            }
        }

        try {
            var roleOperator = require('roleOperator');
            if (roleOperator && typeof roleOperator.findPowerObserver === 'function') {
                var po = roleOperator.findPowerObserver(roomName);
                if (po) {
                    Memory.intelPowerObserve[poKey] = { operatorName: po.operatorName, operatorRoom: po.operatorRoom, observerId: po.observerId, tick: Game.time };
                    Memory.nukeAnalyzePending[roomName] = { tick: Game.time, observerRoom: po.operatorRoom, poweredObserver: true, numNukes: numNukes };
                    console.log('[NukeAnalyze] 🔭⚡ Requesting PWR_OPERATE_OBSERVER from ' + po.operatorName + '. Will auto-complete when visible.');
                    return { status: 'pending_power_observe', room: roomName, operatorName: po.operatorName };
                }
            }
        } catch (e) {}

        console.log('[NukeAnalyze] ERROR: ' + roomName + ' is not visible. No observer in range. Send a scout.');
        return null;
    }

    delete Memory.nukeAnalyzePending[roomName];

    var priceCache  = buildPriceCache(room);
    var energyPrice = priceCache[RESOURCE_ENERGY]  || 0;
    var ghPrice     = priceCache[RESOURCE_GHODIUM] || 0;
    var nukeCostOne = (NUKE_ENERGY_COST * energyPrice) + (NUKE_GHODIUM_COST * ghPrice);
    var nukeCostAll = nukeCostOne * numNukes;
    var owner       = (room.controller && room.controller.owner) ? room.controller.owner.username : 'Unowned';
    var rcl         = room.controller ? room.controller.level : 0;

    var simState    = buildSimState(room);
    var strikes     = [];
    var totalDamage = 0;

    for (var n = 0; n < numNukes; n++) {
        var best = findBestStrike(simState, priceCache);
        if (best.totalCredits === 0) break;
        simulateStrike(best.cx, best.cy, simState, priceCache);
        totalDamage += best.totalCredits;
        strikes.push(best);
    }

    var totalPct = nukeCostAll > 0 ? (totalDamage / nukeCostAll * 100).toFixed(1) : 'inf';
    var lines    = [];
    var div      = '════════════════════════════════════════════════════════════════════════';

    lines.push(div);
    lines.push('NUKE ANALYSIS: ' + roomName + '  |  Owner: ' + owner + '  |  RCL: ' + rcl + '  |  Nukes: ' + numNukes);
    lines.push(div);
    lines.push('💰 Cost per nuke: ' + fmt(nukeCostOne) +
        '  (' + fmtNum(NUKE_ENERGY_COST) + 'e @' + energyPrice.toFixed(4) +
        '  +  ' + NUKE_GHODIUM_COST + 'G @' + ghPrice.toFixed(2) + '/G)' +
        (numNukes > 1 ? '   Total: ' + fmt(nukeCostAll) : ''));

    for (var s = 0; s < strikes.length; s++) {
        var strike  = strikes[s];
        var margPct = nukeCostOne > 0 ? (strike.totalCredits / nukeCostOne * 100).toFixed(1) : 'inf';
        lines.push('');
        lines.push('  Strike ' + (s + 1) + ':  (' + strike.cx + ', ' + strike.cy + ')  →  ' + fmt(strike.totalCredits) + '  (' + margPct + '% of 1 nuke cost)');

        if (strike.destroyed.length > 0) {
            var byType = {};
            for (var d = 0; d < strike.destroyed.length; d++) {
                var entry = strike.destroyed[d];
                if (!byType[entry.type]) byType[entry.type] = { count: 0, value: 0, storedValue: 0 };
                byType[entry.type].count++;
                byType[entry.type].value       += entry.value;
                byType[entry.type].storedValue += (entry.storedValue || 0);
            }
            for (var t in byType) {
                var g   = byType[t];
                var row = '    ' + t + ' x' + g.count + '  ->  ' + fmt(g.value);
                if (g.storedValue > 0) row += '  (build: ' + fmt(g.value - g.storedValue) + ' + stored: ' + fmt(g.storedValue) + ')';
                lines.push(row);
            }
        }
        if (strike.rampartsHit.length > 0) {
            var repairTotal = 0;
            for (var ri = 0; ri < strike.rampartsHit.length; ri++) repairTotal += strike.rampartsHit[ri].repairCost;
            lines.push('    rampart repairs: ' + strike.rampartsHit.length + '  ->  ' + fmt(repairTotal));
        }
        if (strike.shielded.length > 0) lines.push('    shielded (survived): ' + strike.shielded.length + ' structure(s)');
    }

    if (strikes.length === 0) { lines.push(''); lines.push('  No structures in blast range or all fully shielded.'); }

    lines.push('');
    lines.push(div);
    if (numNukes === 1) {
        var sp = strikes[0] || { cx: 0, cy: 0 };
        lines.push('In room \'' + roomName + '\', striking (' + sp.cx + ', ' + sp.cy + ') will do ' + fmt(totalDamage) + ' in damage (' + totalPct + '% of nuke cost)');
    } else {
        var coordList = strikes.map(function(st) { return '(' + st.cx + ', ' + st.cy + ')'; }).join('  ');
        lines.push('Total damage (' + strikes.length + ' nukes): ' + fmt(totalDamage) + '  (' + totalPct + '% of total nuke investment of ' + fmt(nukeCostAll) + ')');
        lines.push('Targets: ' + coordList);
    }
    lines.push(div);
    console.log(lines.join('\n'));

    return {
        room: roomName, numNukes: numNukes,
        strikes: strikes.map(function(st) { return { x: st.cx, y: st.cy, damage: st.totalCredits }; }),
        totalDamage: totalDamage, nukeCostOne: nukeCostOne, nukeCostAll: nukeCostAll, percent: parseFloat(totalPct)
    };
}

// ─── nukeAnalyzeCost ──────────────────────────────────────────────────────────

/**
 * nukeAnalyzeCost(roomName, cx, cy)
 * nukeAnalyzeCost(roomName, [{x,y}, ...])
 *
 * Single entry point for strike cost analysis — no separate function or global needed.
 *
 * When called with plain x,y numbers (manual console use), analyses that one strike.
 * When called with an array of strike coords (as nukeIncoming() does automatically
 * when >= 2 nukes are detected), damage from every simultaneous strike is SUMMED
 * per tile BEFORE the rampart check — a tile hit by two area nukes correctly needs
 * >10M HP, not just >5M. Overlapping tiles show their stacked total in the output.
 *
 * Observer / PWR_OPERATE_OBSERVER fallback works for both forms; the full strikes
 * array is persisted in Memory so auto-complete replays the exact same call.
 */
function nukeAnalyzeCost(roomName, cxOrStrikes, cy) {
    if (!roomName || typeof roomName !== 'string') {
        console.log('[NukeAnalyzeCost] Usage: nukeAnalyzeCost("W1N1", x, y)  OR  nukeAnalyzeCost("W1N1", [{x,y},…])');
        return null;
    }

    // ── Normalise arguments into a strikes array ───────────────────────────
    var strikes;
    if (Array.isArray(cxOrStrikes)) {
        strikes = [];
        for (var vi = 0; vi < cxOrStrikes.length; vi++) {
            var sx = parseInt(cxOrStrikes[vi].x, 10);
            var sy = parseInt(cxOrStrikes[vi].y, 10);
            if (isNaN(sx) || isNaN(sy) || sx < 2 || sx > 47 || sy < 2 || sy > 47) {
                console.log('[NukeAnalyzeCost] Skipping invalid coordinate: (' + cxOrStrikes[vi].x + ', ' + cxOrStrikes[vi].y + ')');
                continue;
            }
            strikes.push({ x: sx, y: sy });
        }
        if (strikes.length === 0) {
            console.log('[NukeAnalyzeCost] No valid strike coordinates provided.');
            return null;
        }
    } else {
        var cx  = parseInt(cxOrStrikes, 10);
        var cy2 = parseInt(cy, 10);
        if (isNaN(cx) || isNaN(cy2) || cx < 2 || cx > 47 || cy2 < 2 || cy2 > 47) {
            console.log('[NukeAnalyzeCost] Coordinates must be integers in range 2–47.');
            return null;
        }
        strikes = [{ x: cx, y: cy2 }];
    }

    if (!Memory.nukeAnalyzePending) Memory.nukeAnalyzePending = {};
    if (!Memory.intelPowerObserve)  Memory.intelPowerObserve  = {};

    var room = Game.rooms[roomName];

    // ── Room not visible — observer fallback ──────────────────────────────
    if (!room) {
        var poKey = roomName;

        if (Memory.intelPowerObserve[poKey]) {
            var req     = Memory.intelPowerObserve[poKey];
            var elapsed = Game.time - req.tick;
            if (elapsed <= 50) {
                console.log('[NukeAnalyzeCost] ⏳ PWR_OPERATE_OBSERVER in progress — operator: ' + req.operatorName + ', elapsed: ' + elapsed + ' ticks. Call again soon.');
                return { status: 'pending_power_observe', room: roomName };
            }
            delete Memory.intelPowerObserve[poKey];
        }

        var observer = findObserverInRange(roomName);
        if (observer) {
            var obsResult = observer.observeRoom(roomName);
            if (obsResult === OK) {
                // Persist the full strikes array so auto-complete replays identically
                Memory.nukeAnalyzePending[roomName] = {
                    tick:         Game.time,
                    observerRoom: observer.room.name,
                    costMode:     true,
                    strikes:      strikes
                };
                console.log('[NukeAnalyzeCost] 🔭 Observing ' + roomName + ' via observer in ' + observer.room.name + '. Auto-completing next tick.');
                return { status: 'pending', room: roomName, observerRoom: observer.room.name };
            }
            console.log('[NukeAnalyzeCost] Observer found but observeRoom() returned code ' + obsResult + '.');
        }

        try {
            var roleOperator = require('roleOperator');
            if (roleOperator && typeof roleOperator.findPowerObserver === 'function') {
                var po = roleOperator.findPowerObserver(roomName);
                if (po) {
                    Memory.intelPowerObserve[poKey] = { operatorName: po.operatorName, operatorRoom: po.operatorRoom, observerId: po.observerId, tick: Game.time };
                    Memory.nukeAnalyzePending[roomName] = { tick: Game.time, observerRoom: po.operatorRoom, poweredObserver: true, costMode: true, strikes: strikes };
                    console.log('[NukeAnalyzeCost] 🔭⚡ Requesting PWR_OPERATE_OBSERVER from ' + po.operatorName + '. Will auto-complete when visible.');
                    return { status: 'pending_power_observe', room: roomName, operatorName: po.operatorName };
                }
            }
        } catch (e) {}

        console.log('[NukeAnalyzeCost] ERROR: ' + roomName + ' is not visible. No observer in range. Send a scout.');
        return null;
    }

    // ── Room is visible ────────────────────────────────────────────────────

    var priceCache    = buildPriceCache(room);
    var energyPrice   = priceCache[RESOURCE_ENERGY] || 0;
    var allStructures = room.find(FIND_STRUCTURES);

    var structureMap = {};
    for (var si = 0; si < allStructures.length; si++) {
        var sv = allStructures[si];
        var sk = sv.pos.x + ',' + sv.pos.y;
        if (!structureMap[sk]) structureMap[sk] = [];
        structureMap[sk].push(sv);
    }

    function isIgnored(type) {
        return type === STRUCTURE_ROAD || type === STRUCTURE_WALL ||
               type === STRUCTURE_CONTAINER || type === STRUCTURE_RAMPART ||
               type === STRUCTURE_CONTROLLER;   // FIX #12: also ignore controllers
    }

    // ── Build per-tile stacked damage map ─────────────────────────────────
    var tileDamage = {};

    for (var ni = 0; ni < strikes.length; ni++) {
        var scx = strikes[ni].x;
        var scy = strikes[ni].y;
        for (var dx = -2; dx <= 2; dx++) {
            for (var dy = -2; dy <= 2; dy++) {
                var tx = scx + dx;
                var ty = scy + dy;
                if (tx < 0 || tx > 49 || ty < 0 || ty > 49) continue;
                var dmg = (dx === 0 && dy === 0) ? NUKE_DIRECT_DAMAGE : NUKE_AREA_DAMAGE;
                var tk  = tx + ',' + ty;
                if (!tileDamage[tk]) tileDamage[tk] = { total: 0, contributions: [] };
                tileDamage[tk].total += dmg;
                tileDamage[tk].contributions.push({ strikeIdx: ni, dmg: dmg });
            }
        }
    }

    // ── Per-tile analysis using stacked damage totals ─────────────────────
    var totalReplaceBuildEnergy  = 0;
    var totalReplaceStored       = 0;
    var totalRampartAtRiskEnergy = 0;
    var totalTopupEnergy         = 0;
    var totalFullRampartEnergy   = 0;
    var totalForceRepairEnergy   = 0;
    var tileResults              = [];

    for (var tkey in tileDamage) {
        var tparts   = tkey.split(',');
        var x        = parseInt(tparts[0], 10);
        var y        = parseInt(tparts[1], 10);
        var tileInfo = tileDamage[tkey];
        var nukeHits = tileInfo.total;

        var structs = structureMap[tkey] || [];

        var bestRampart = null;
        var buildings   = [];
        for (var i = 0; i < structs.length; i++) {
            var s = structs[i];
            if (s.structureType === STRUCTURE_RAMPART) {
                if (!bestRampart || s.hits > bestRampart.hits) bestRampart = s;
            } else if (!isIgnored(s.structureType)) {
                buildings.push(s);
            }
        }

        if (buildings.length === 0) continue;

        var currentHP     = bestRampart ? bestRampart.hits : 0;
        var rampartBlocks = bestRampart && (currentHP > nukeHits);
        var hpShortfall   = Math.max(0, nukeHits - currentHP + 1);

        var isCenter = false;
        for (var ci = 0; ci < tileInfo.contributions.length; ci++) {
            if (tileInfo.contributions[ci].dmg === NUKE_DIRECT_DAMAGE) { isCenter = true; break; }
        }

        var tileReplaceBuild  = 0;
        var tileReplaceStored = 0;
        var buildingDetails   = [];

        for (var b = 0; b < buildings.length; b++) {
            var bld         = buildings[b];
            var buildEnergy = BUILD_COST[bld.structureType] || 0;
            var storedCr    = 0;
            if (bld.store) {
                for (var res in bld.store) {
                    var amt = bld.store[res] || 0;
                    if (amt <= 0) continue;
                    var price = priceCache[res] !== undefined ? priceCache[res] : getMarketBuyPrice(res);
                    storedCr += amt * price;
                }
            }
            tileReplaceBuild  += buildEnergy;
            tileReplaceStored += storedCr;
            buildingDetails.push({ type: bld.structureType, buildEnergy: buildEnergy, storedCredits: storedCr });
        }

        totalReplaceBuildEnergy += tileReplaceBuild;
        totalReplaceStored      += tileReplaceStored;

        var rampartAtRiskEnergy = 0;
        var topupEnergy         = 0;
        var fullRampartEnergy   = 0;
        var forceRepairEnergy   = 0;

        if (!bestRampart) {
            fullRampartEnergy       = hpShortfall / REPAIR_HITS_PER_ENERGY;
            totalFullRampartEnergy += fullRampartEnergy;
        } else if (!rampartBlocks) {
            rampartAtRiskEnergy      = currentHP / REPAIR_HITS_PER_ENERGY;
            topupEnergy              = hpShortfall / REPAIR_HITS_PER_ENERGY;
            totalRampartAtRiskEnergy += rampartAtRiskEnergy;
            totalTopupEnergy         += topupEnergy;
        } else {
            forceRepairEnergy       = nukeHits / REPAIR_HITS_PER_ENERGY;
            totalForceRepairEnergy += forceRepairEnergy;
        }

        tileResults.push({
            x: x, y: y, isCenter: isCenter, nukeHits: nukeHits,
            contributions: tileInfo.contributions, currentRampartHP: currentHP,
            rampartBlocks: rampartBlocks, hpShortfall: hpShortfall,
            buildings: buildingDetails,
            tileReplaceBuild: tileReplaceBuild, tileReplaceStored: tileReplaceStored,
            rampartAtRiskEnergy: rampartAtRiskEnergy, topupEnergy: topupEnergy,
            fullRampartEnergy: fullRampartEnergy, forceRepairEnergy: forceRepairEnergy
        });
    }

    tileResults.sort(function(a, b) { return a.y !== b.y ? a.y - b.y : a.x - b.x; });

    // ── Build report ──────────────────────────────────────────────────────
    var div  = '════════════════════════════════════════════════════════════════════════';
    var div2 = '────────────────────────────────────────────────────────────────────────';
    var lines = [];
    var owner = (room.controller && room.controller.owner) ? room.controller.owner.username : 'Unowned';
    var rcl   = room.controller ? room.controller.level : 0;

    var strikeCoords = strikes.map(function(s) { return '(' + s.x + ',' + s.y + ')'; }).join('  +  ');

    lines.push(div);
    lines.push('NUKE COST ANALYSIS: ' + roomName + ' @ ' + strikeCoords + '  |  Owner: ' + owner + '  |  RCL: ' + rcl);
    if (strikes.length > 1) {
        lines.push('⚠️  ' + strikes.length + ' simultaneous strikes — damage is STACKED per tile. HP thresholds reflect combined incoming damage.');
    }
    lines.push(div);
    lines.push('Energy price: ' + energyPrice.toFixed(4) + ' cr/e' +
        '  |  Structures in room: ' + allStructures.length +
        '  |  Building tiles in blast: ' + tileResults.length);
    lines.push('');
    lines.push('PER-TILE BREAKDOWN:  (roads, walls, containers, controllers ignored; empty tiles omitted)');
    lines.push(div2);

    for (var t = 0; t < tileResults.length; t++) {
        var tile = tileResults[t];

        var dmgLabel;
        if (tile.contributions.length === 1) {
            dmgLabel = tile.isCenter ? '10M direct' : '5M area  ';
        } else {
            var contribParts = tile.contributions.map(function(c) { return fmtNum(c.dmg); }).join('+');
            dmgLabel = contribParts + '=' + fmtNum(tile.nukeHits) + ' stacked';
        }
        var label = (tile.isCenter && tile.contributions.length === 1)
            ? '  [CENTER] (' + tile.x + ',' + tile.y + ')  ' + dmgLabel
            : '  [AREA]   (' + tile.x + ',' + tile.y + ')   ' + dmgLabel;

        var rampartTag;
        if (tile.currentRampartHP === 0) {
            rampartTag = '❌ no rampart';
        } else if (tile.rampartBlocks) {
            rampartTag = '✅ rampart OK  ' + fmtNum(tile.currentRampartHP) + ' HP  (need >' + fmtNum(tile.nukeHits) + ')';
        } else {
            rampartTag = '⚠️  rampart WEAK  ' + fmtNum(tile.currentRampartHP) + ' HP  (need >' + fmtNum(tile.nukeHits) + ')';
        }
        lines.push(label + '  |  ' + rampartTag);

        for (var bd = 0; bd < tile.buildings.length; bd++) {
            var binfo = tile.buildings[bd];
            var brow  = '      🏗  ' + binfo.type + '  rebuild: ' + fmtNum(binfo.buildEnergy) + 'e  (' + fmt(binfo.buildEnergy * energyPrice) + ')';
            if (binfo.storedCredits > 0) brow += '  +  stored: ' + fmt(binfo.storedCredits);
            brow += tile.rampartBlocks ? '  🛡️ protected' : '  💥 at risk';
            lines.push(brow);
        }

        if (tile.rampartBlocks) {
            var frE = tile.forceRepairEnergy;
            lines.push('      🔧 Rampart repair after hit: ' + fmtNum(frE) + 'e  (' + fmt(frE * energyPrice) + ')');
        } else if (tile.currentRampartHP > 0) {
            var arE = tile.rampartAtRiskEnergy;
            var tuE = tile.topupEnergy;
            lines.push('      📉 Rampart investment at risk: ' + fmtNum(tile.currentRampartHP) + ' HP  =  ' + fmtNum(arE) + 'e  (' + fmt(arE * energyPrice) + ')');
            lines.push('      🔧 To protect: need ' + fmtNum(tile.hpShortfall) + ' more HP  =  ' + fmtNum(tuE) + 'e  (' + fmt(tuE * energyPrice) + ')');
        } else {
            var frE2 = tile.fullRampartEnergy;
            lines.push('      🔧 To protect: need ' + fmtNum(tile.nukeHits + 1) + ' HP rampart from scratch  =  ' + fmtNum(frE2) + 'e  (' + fmt(frE2 * energyPrice) + ')');
        }
    }

    if (tileResults.length === 0) lines.push('  No meaningful structures found in blast area.');

    var totalReplaceCredits     = (totalReplaceBuildEnergy * energyPrice) + totalReplaceStored;
    var totalAtRiskCredits      = totalRampartAtRiskEnergy * energyPrice;
    var totalProtectEnergy      = totalTopupEnergy + totalFullRampartEnergy;
    var totalProtectCredits     = totalProtectEnergy * energyPrice;
    var totalForceRepairCredits = totalForceRepairEnergy * energyPrice;

    lines.push('');
    lines.push(div);
    lines.push('REPLACEMENT COST  (all buildings in blast, ignoring rampart protection):');
    lines.push('  Build energy:     ' + fmtNum(totalReplaceBuildEnergy) + 'e  (' + fmt(totalReplaceBuildEnergy * energyPrice) + ')');
    lines.push('  Lost resources:   ' + fmt(totalReplaceStored));
    lines.push('  TOTAL:            ' + fmt(totalReplaceCredits));
    lines.push('');
    lines.push('DEFENSE COST  (what it takes to protect every building tile vs ALL strikes):');
    if (totalTopupEnergy > 0)       lines.push('  Top up weak ramparts:   ' + fmtNum(totalTopupEnergy) + 'e  (' + fmt(totalTopupEnergy * energyPrice) + ')');
    if (totalFullRampartEnergy > 0) lines.push('  Build new ramparts:     ' + fmtNum(totalFullRampartEnergy) + 'e  (' + fmt(totalFullRampartEnergy * energyPrice) + ')');
    lines.push('  TOTAL to protect:       ' + fmtNum(totalProtectEnergy) + 'e  (' + fmt(totalProtectCredits) + ')');
    if (totalForceRepairEnergy > 0) lines.push('  Post-strike repairs:    ' + fmtNum(totalForceRepairEnergy) + 'e  (' + fmt(totalForceRepairCredits) + ')  (already-shielded tiles only)');
    if (totalRampartAtRiskEnergy > 0) {
        lines.push('');
        lines.push('SUNK COST AT RISK  (rampart HP investment lost if strike hits now):');
        lines.push('  ' + fmtNum(totalRampartAtRiskEnergy) + 'e  (' + fmt(totalAtRiskCredits) + ')');
    }
    lines.push(div);

    console.log(lines.join('\n'));

    return {
        room: roomName, strikes: strikes,
        totalReplaceBuildEnergy: totalReplaceBuildEnergy,
        totalReplaceStored: totalReplaceStored,
        totalReplaceCredits: totalReplaceCredits,
        totalProtectEnergy: totalProtectEnergy,
        totalProtectCredits: totalProtectCredits,
        tiles: tileResults
    };
}

// ─── Auto-complete pending observations ──────────────────────────────────────

function processPendingNukeAnalyze() {
    if (!Memory.nukeAnalyzePending) return;

    for (var roomName in Memory.nukeAnalyzePending) {
        var pending = Memory.nukeAnalyzePending[roomName];
        var age     = Game.time - pending.tick;

        if (Game.rooms[roomName]) {
            if (pending.incomingMode) {
                console.log('[NukeIncoming] 🔭 Auto-completing incoming scan for ' + roomName + ' (observed from ' + pending.observerRoom + ')');
                _scanRoomForNukes(roomName, Game.rooms[roomName]);
            } else if (pending.costMode) {
                console.log('[NukeAnalyzeCost] 🔭 Auto-completing cost analysis for ' + roomName + ' (observed from ' + pending.observerRoom + ')');
                nukeAnalyzeCost(roomName, pending.strikes);
            } else {
                console.log('[NukeAnalyze] 🔭 Auto-completing analysis for ' + roomName + ' (observed from ' + pending.observerRoom + ')');
                nukeAnalyze(roomName, pending.numNukes || 1);
            }
            delete Memory.nukeAnalyzePending[roomName];

        } else if (pending.poweredObserver) {
            // Let intelPowerObserve drive the timeout

        } else if (age >= 5) {
            console.log('[NukeAnalyze] ⚠️  Timed out waiting for visibility of ' + roomName + ' after ' + age + ' ticks. Clearing.');
            delete Memory.nukeAnalyzePending[roomName];
        }
    }

    if (Memory.intelPowerObserve) {
        for (var poRoom in Memory.intelPowerObserve) {
            var poReq = Memory.intelPowerObserve[poRoom];
            if (!poReq || !poReq.tick) continue;
            if (!Memory.nukeAnalyzePending || !Memory.nukeAnalyzePending[poRoom]) continue;
            if (Game.time - poReq.tick > 100) {
                console.log('[NukeAnalyze] ⚠️  Power-observe timed out for ' + poRoom + ' after 100 ticks. Clearing.');
                delete Memory.intelPowerObserve[poRoom];
                delete Memory.nukeAnalyzePending[poRoom];
            }
        }
    }

    // Also advance threat scans every tick
    processNukeThreatScan();
}

// ─── Self analysis ────────────────────────────────────────────────────────────

function nukeAnalyzeSelf() {
    var myRooms = [];
    for (var roomName in Game.rooms) {
        var room = Game.rooms[roomName];
        if (room.controller && room.controller.my) myRooms.push(roomName);
    }
    if (myRooms.length === 0) { console.log('[NukeAnalyze] No owned rooms visible.'); return; }

    var energyPrice = getMarketBuyPrice(RESOURCE_ENERGY);
    var ghPrice     = getMarketBuyPrice(RESOURCE_GHODIUM);
    var nukeCost    = (NUKE_ENERGY_COST * energyPrice) + (NUKE_GHODIUM_COST * ghPrice);
    var lines       = ['NUKE SELF-ANALYSIS  |  Nuke cost: ' + fmt(nukeCost), '---'];

    myRooms.sort();
    for (var i = 0; i < myRooms.length; i++) {
        var rn            = myRooms[i];
        var room          = Game.rooms[rn];
        var priceCache    = buildPriceCache(room);
        var allStructures = room.find(FIND_STRUCTURES);
        var structureMap  = {};
        for (var j = 0; j < allStructures.length; j++) {
            var s   = allStructures[j];
            // FIX #12: Skip controllers here too.
            if (s.structureType === STRUCTURE_CONTROLLER) continue;
            var key = s.pos.x + ',' + s.pos.y;
            if (!structureMap[key]) structureMap[key] = [];
            structureMap[key].push(s);
        }
        var best = { totalCredits: 0, cx: 25, cy: 25 };
        for (var cx = 2; cx <= 47; cx++) {
            for (var cy = 2; cy <= 47; cy++) {
                var result = analyzeStrike(cx, cy, structureMap, priceCache);
                if (result.totalCredits > best.totalCredits) { best = result; best.cx = cx; best.cy = cy; }
            }
        }
        var pct = nukeCost > 0 ? (best.totalCredits / nukeCost * 100).toFixed(1) : 'inf';
        var rcl = room.controller ? room.controller.level : 0;
        lines.push(rn + ' (RCL' + rcl + ')  -  Best: (' + best.cx + ', ' + best.cy + ')  -  ' + fmt(best.totalCredits) + '  (' + pct + '% of nuke cost)');
    }
    console.log(lines.join('\n'));
}

// ─── nukeIncoming ─────────────────────────────────────────────────────────────

function nukeIncoming(filterRoom) {
    if (!Memory.nukeAnalyzePending) Memory.nukeAnalyzePending = {};
    if (!Memory.intelPowerObserve)  Memory.intelPowerObserve  = {};

    if (filterRoom) {
        if (typeof filterRoom !== 'string') {
            console.log('[NukeIncoming] Usage: nukeIncoming() or nukeIncoming("W1N46")');
            return null;
        }

        var room = Game.rooms[filterRoom];
        if (!room) {
            var poKey = filterRoom;

            if (Memory.intelPowerObserve[poKey]) {
                var req     = Memory.intelPowerObserve[poKey];
                var elapsed = Game.time - req.tick;
                if (elapsed <= 50) {
                    console.log('[NukeIncoming] ⏳ PWR_OPERATE_OBSERVER in progress — operator: ' + req.operatorName + ', elapsed: ' + elapsed + ' ticks.');
                    return { status: 'pending_power_observe', room: filterRoom };
                }
                delete Memory.intelPowerObserve[poKey];
            }

            var observer = findObserverInRange(filterRoom);
            if (observer) {
                var obsResult = observer.observeRoom(filterRoom);
                if (obsResult === OK) {
                    Memory.nukeAnalyzePending[filterRoom] = { tick: Game.time, observerRoom: observer.room.name, incomingMode: true };
                    console.log('[NukeIncoming] 🔭 Observing ' + filterRoom + ' via observer in ' + observer.room.name + '. Auto-completing incoming scan next tick.');
                    return { status: 'pending', room: filterRoom, observerRoom: observer.room.name };
                }
            }

            try {
                var roleOperator = require('roleOperator');
                if (roleOperator && typeof roleOperator.findPowerObserver === 'function') {
                    var po = roleOperator.findPowerObserver(filterRoom);
                    if (po) {
                        Memory.intelPowerObserve[poKey] = { operatorName: po.operatorName, operatorRoom: po.operatorRoom, observerId: po.observerId, tick: Game.time };
                        Memory.nukeAnalyzePending[filterRoom] = { tick: Game.time, observerRoom: po.operatorRoom, poweredObserver: true, incomingMode: true };
                        console.log('[NukeIncoming] 🔭⚡ Requesting PWR_OPERATE_OBSERVER from ' + po.operatorName + '. Will auto-complete when visible.');
                        return { status: 'pending_power_observe', room: filterRoom, operatorName: po.operatorName };
                    }
                }
            } catch (e) {}

            console.log('[NukeIncoming] ERROR: ' + filterRoom + ' is not visible. No observer in range. Send a scout.');
            return null;
        }

        return _scanRoomForNukes(filterRoom, room);
    }

    var myRooms    = [];
    var totalFound = 0;
    for (var roomName in Game.rooms) {
        var r = Game.rooms[roomName];
        if (r.controller && r.controller.my) myRooms.push(roomName);
    }
    if (myRooms.length === 0) { console.log('[NukeIncoming] No owned rooms visible.'); return null; }

    myRooms.sort();
    for (var i = 0; i < myRooms.length; i++) totalFound += _scanRoomForNukes(myRooms[i], Game.rooms[myRooms[i]]);
    if (totalFound === 0) console.log('[NukeIncoming] ✅ No incoming nukes detected in any owned room.');
    return totalFound;
}

function _scanRoomForNukes(roomName, room) {
    var div  = '════════════════════════════════════════════════════════════════════════';
    var div2 = '────────────────────────────────────────────────────────────────────────';

    var nukes = room.find(FIND_NUKES);
    if (!nukes || nukes.length === 0) return 0;

    nukes.sort(function(a, b) { return a.timeToLand - b.timeToLand; });

    for (var n = 0; n < nukes.length; n++) {
        var nuke     = nukes[n];
        var landTick = Game.time + nuke.timeToLand;
        console.log(div);
        console.log('☢️  INCOMING NUKE  →  ' + roomName +
            '  |  Landing @ (' + nuke.pos.x + ', ' + nuke.pos.y + ')' +
            '  |  ' + nuke.timeToLand + ' ticks remaining  (tick ' + landTick + ')' +
            '  |  From: ' + (nuke.launchRoomName || '???'));
        console.log(div2);
    }

    var strikes = nukes.map(function(nk) { return { x: nk.pos.x, y: nk.pos.y }; });
    nukeAnalyzeCost(roomName, strikes);

    return nukes.length;
}

// ─── nukeThreat & threat scan ─────────────────────────────────────────────────

/**
 * Checks if a nuker is ready to fire (cooldown=0 and fully stocked).
 */
function isNukerOperational(nuker) {
    if (!nuker || nuker.cooldown > 0) return false;
    var store = nuker.store;
    return (store[RESOURCE_GHODIUM] >= NUKE_GHODIUM_COST &&
            store[RESOURCE_ENERGY] >= NUKE_ENERGY_COST);
}

/**
 * Initialise (or reset) a threat scan for the specified target room.
 *
 * FIX #9: Renamed the guard field from 'resetTick' (misleading — it reads like
 * "the tick we last reset on", but it's actually "the tick we were created on")
 * to 'createdTick' so the intent is unambiguous.
 */
function ensureThreatScanMemory(targetRoom) {
    if (!Memory.nukeThreatScans) Memory.nukeThreatScans = {};
    var scan = Memory.nukeThreatScans[targetRoom];
    if (!scan || scan.createdTick !== Game.time) {
        scan = {
            target:            targetRoom,
            started:           Game.time,
            createdTick:       Game.time,   // prevent re-init on same-tick calls
            roomsToScan:       {},
            unscannableCount:  0,
            scannedCount:      0,
            scanComplete:      false,
            bestHostileOwner:  null,
            operationalNukeCount: 0,
            threatPossible:    false
        };
        var rangeRooms = roomsInRange(targetRoom, OBSERVER_RANGE);
        for (var i = 0; i < rangeRooms.length; i++) {
            var rn = rangeRooms[i];
            if (rn === targetRoom) continue;
            scan.roomsToScan[rn] = { status: 'unscanned', data: {} };
        }
        Memory.nukeThreatScans[targetRoom] = scan;
    }
    return scan;
}

/**
 * Main processor for threat scans.  Called every tick by processPendingNukeAnalyze().
 *
 * Observation state is tracked entirely within Memory.nukeThreatScans so that
 * this function never touches Memory.nukeAnalyzePending or Memory.intelPowerObserve.
 * Writing to those shared keys was causing the intel module to auto-trigger
 * efficiency profiles for every room the threat scan observed.
 *
 * Powered-observer requests are stored in Memory.nukeThreatPowerObserve instead.
 * NOTE: your roleOperator module must also read Memory.nukeThreatPowerObserve and
 * act on it the same way it acts on Memory.intelPowerObserve.
 */
function processNukeThreatScan() {
    if (!Memory.nukeThreatScans) return;
    if (!Memory.nukeThreatPowerObserve) Memory.nukeThreatPowerObserve = {};

    var usedObservers = new Set();

    for (var targetRoom in Memory.nukeThreatScans) {
        var scan = Memory.nukeThreatScans[targetRoom];
        if (!scan || scan.scanComplete) continue;

        // Phase 1: handle rooms that are now visible
        for (var rn in scan.roomsToScan) {
            var entry = scan.roomsToScan[rn];
            if (entry.status === 'visible' || entry.status === 'fail') continue;

            var room = Game.rooms[rn];
            if (room) {
                entry.status = 'visible';
                entry.data.owner = (room.controller && room.controller.owner)
                                   ? room.controller.owner.username : null;
                var opNukeCount = 0;
                if (entry.data.owner && !isFriendlyUsername(entry.data.owner)) {
                    var nukers = room.find(FIND_STRUCTURES, {
                        filter: function(s) { return s.structureType === STRUCTURE_NUKER && isNukerOperational(s); }
                    });
                    opNukeCount = nukers.length;
                }
                entry.data.opNukeCount = opNukeCount;
                scan.scannedCount++;
                // Clean up any powered-observer request we placed for this room
                delete Memory.nukeThreatPowerObserve[rn];
                continue;
            }

            if (entry.status === 'unscanned') {
                // Try structural observer first — does not touch any shared memory key
                if (tryObserveRoom(rn, usedObservers)) {
                    entry.status = 'pending';
                    entry.observeTick = Game.time;
                    continue;
                }

                // Structural observer not in range — try PWR_OPERATE_OBSERVER.
                // Write to Memory.nukeThreatPowerObserve (NOT Memory.intelPowerObserve)
                // so the intel module never sees this request and won't auto-profile the room.
                try {
                    var roleOperator = require('roleOperator');
                    if (roleOperator && typeof roleOperator.findPowerObserver === 'function') {
                        var po = roleOperator.findPowerObserver(rn);
                        if (po) {
                            Memory.nukeThreatPowerObserve[rn] = {
                                operatorName: po.operatorName,
                                operatorRoom: po.operatorRoom,
                                observerId:   po.observerId,
                                tick:         Game.time
                            };
                            entry.status    = 'pending';
                            entry.observeTick = Game.time;
                            continue;
                        }
                    }
                } catch (e) { /* ignore */ }

                entry.status = 'fail';
                scan.unscannableCount++;
            }

            // Timeout: if a room has been 'pending' for too long without becoming
            // visible, give up on it rather than blocking the whole scan forever.
            if (entry.status === 'pending' && entry.observeTick !== undefined &&
                    Game.time - entry.observeTick > 10) {
                entry.status = 'fail';
                scan.unscannableCount++;
                delete Memory.nukeThreatPowerObserve[rn];
            }
        }

        // Phase 2: check if scan is complete
        var unfinished = false;
        for (var rn2 in scan.roomsToScan) {
            var e2 = scan.roomsToScan[rn2];
            if (e2.status === 'unscanned' || e2.status === 'pending') {
                unfinished = true;
                break;
            }
        }
        if (!unfinished) {
            scan.scanComplete = true;
            runFinalThreatAnalysis(targetRoom, scan);
        }
    }

    // FIX #8: TTL sweep — remove completed scans that are older than 1000 ticks
    // so Memory.nukeThreatScans doesn't grow unboundedly.
    for (var tr in Memory.nukeThreatScans) {
        var ts = Memory.nukeThreatScans[tr];
        if (ts && ts.scanComplete && Game.time - ts.started > 1000) {
            delete Memory.nukeThreatScans[tr];
        }
    }

    // Clean up any nukeThreatPowerObserve entries older than 100 ticks (operator
    // never picked them up, or the room never became visible).
    for (var pr in Memory.nukeThreatPowerObserve) {
        if (Game.time - Memory.nukeThreatPowerObserve[pr].tick > 100) {
            delete Memory.nukeThreatPowerObserve[pr];
        }
    }
}

/**
 * Finalise threat scan: find most dangerous hostile player and test key‑structure destruction.
 *
 * FIX #3: Track terminal/storage *existence* separately from destruction status.
 * Previously both flags started as false and only flipped on a destroyed structure,
 * so rooms without a terminal (RCL ≤ 5) or storage (RCL ≤ 3) always reported
 * "still standing: terminal, storage" even when those structures don't exist.
 */
function runFinalThreatAnalysis(targetRoom, scan) {
    var nukeCountByOwner = {};
    for (var rn in scan.roomsToScan) {
        var entry = scan.roomsToScan[rn];
        if (entry.status !== 'visible' || !entry.data.owner) continue;
        var owner = entry.data.owner;
        if (isFriendlyUsername(owner)) continue;
        var cnt = entry.data.opNukeCount || 0;
        nukeCountByOwner[owner] = (nukeCountByOwner[owner] || 0) + cnt;
    }

    var bestOwner = null;
    var bestNukes = 0;
    for (var ownerName in nukeCountByOwner) {
        if (nukeCountByOwner[ownerName] > bestNukes) {
            bestOwner = ownerName;
            bestNukes = nukeCountByOwner[ownerName];
        }
    }

    scan.bestHostileOwner     = bestOwner;
    scan.operationalNukeCount = bestNukes;

    var totalRooms     = Object.keys(scan.roomsToScan).length;
    var percentScanned = totalRooms > 0
        ? Math.round((scan.scannedCount + scan.unscannableCount) / totalRooms * 100) : 100;
    console.log('[NukeThreat] Scan complete. ' + percentScanned + '% of ' + totalRooms +
                ' rooms processed (' + scan.unscannableCount + ' unscannable).');

    if (!bestOwner || bestNukes === 0) {
        console.log('[NukeThreat] No hostile player with operational nukers within range of ' + targetRoom + '.');
        return;
    }

    console.log('[NukeThreat] Most threatening player: ' + bestOwner +
                ' with ' + bestNukes + ' operational nuke(s) in range.');

    var targetRoomObj = Game.rooms[targetRoom];
    if (!targetRoomObj) {
        console.log('[NukeThreat] ERROR: Target room ' + targetRoom + ' is not currently visible. Cannot run destruction test.');
        return;
    }

    var priceCache = buildPriceCache(targetRoomObj);
    var simState   = buildSimState(targetRoomObj);
    for (var n = 0; n < bestNukes; n++) {
        var best = findBestStrike(simState, priceCache);
        if (best.totalCredits === 0) break;
        simulateStrike(best.cx, best.cy, simState, priceCache);
    }

    // FIX #3: Track existence and destruction separately for terminal/storage so
    // that rooms at lower RCL (which lack these structures) are not falsely
    // reported as having them "still standing".
    var spawnsDestroyed  = true;
    var terminalExists   = false;
    var terminalDestroyed = false;
    var storageExists    = false;
    var storageDestroyed = false;

    var allStructures = targetRoomObj.find(FIND_STRUCTURES);
    for (var i = 0; i < allStructures.length; i++) {
        var s   = allStructures[i];
        var key = s.pos.x + ',' + s.pos.y;
        var tile = simState[key] || [];
        var alive = tile.some(function(e) { return !e.destroyed && e.structureType === s.structureType; });

        if (s.structureType === STRUCTURE_SPAWN && alive) {
            spawnsDestroyed = false;
        }
        if (s.structureType === STRUCTURE_TERMINAL) {
            terminalExists = true;
            if (!alive) terminalDestroyed = true;
        }
        if (s.structureType === STRUCTURE_STORAGE) {
            storageExists = true;
            if (!alive) storageDestroyed = true;
        }
    }

    // A structure "counts as gone" if it doesn't exist in the room at all,
    // or if it was destroyed in the simulation.
    var terminalGone = !terminalExists || terminalDestroyed;
    var storageGone  = !storageExists  || storageDestroyed;

    if (spawnsDestroyed && terminalGone && storageGone) {
        scan.threatPossible = true;
        console.log('[NukeThreat] ✅ YES — ' + bestOwner + ' can destroy ALL spawns, terminal and storage in ' +
                    targetRoom + ' with ' + bestNukes + ' nukes if optimally placed.');
    } else {
        var reason = '';
        if (!spawnsDestroyed) reason += 'spawns, ';
        if (!terminalGone)    reason += 'terminal, ';
        if (!storageGone)     reason += 'storage, ';
        reason = reason.slice(0, -2);
        console.log('[NukeThreat] ❌ NO — ' + bestNukes + ' nukes are NOT enough to destroy all key structures. ' +
                    'Still standing: ' + reason + '.');
    }

    console.log('[NukeThreat] Detailed analysis for ' + targetRoom + ' with ' + bestNukes + ' nukes:');
    nukeAnalyze(targetRoom, bestNukes);
}

/**
 * Console command: nukeThreat('ROOM_NAME')
 */
function nukeThreat(targetRoom) {
    if (!targetRoom || typeof targetRoom !== 'string') {
        console.log('[NukeThreat] Usage: nukeThreat("E1N1")');
        return;
    }
    var scan  = ensureThreatScanMemory(targetRoom);
    var total = Object.keys(scan.roomsToScan).length;
    console.log('[NukeThreat] Scanning ' + total + ' rooms around ' + targetRoom +
                '. Progress reported on completion (use nukeThreatStatus for current status).');
    processNukeThreatScan();
}

/**
 * Console command: nukeThreatStatus('ROOM_NAME')
 */
function nukeThreatStatus(targetRoom) {
    var scan = Memory.nukeThreatScans ? Memory.nukeThreatScans[targetRoom] : null;
    if (!scan) {
        console.log('[NukeThreat] No active scan for ' + targetRoom + '.');
        return;
    }
    var total    = Object.keys(scan.roomsToScan).length;
    var finished = scan.scannedCount + scan.unscannableCount;
    console.log('[NukeThreat] Status for ' + targetRoom + ': ' +
                finished + '/' + total + ' rooms (' +
                scan.scannedCount + ' visible, ' + scan.unscannableCount + ' unscannable). ' +
                (scan.scanComplete ? 'Complete.' : 'In progress.'));
    if (scan.scanComplete && scan.bestHostileOwner) {
        console.log('[NukeThreat] Most threatening: ' + scan.bestHostileOwner +
                    ' with ' + scan.operationalNukeCount + ' nukes. ' +
                    'Can destroy key structures: ' + (scan.threatPossible ? 'YES' : 'NO'));
    }
}

function nukeThreatCancel(targetRoom) {
    if (!targetRoom || typeof targetRoom !== 'string') {
        console.log('[NukeThreatCancel] Usage: nukeThreatCancel("E1N1")');
        return;
    }
    if (Memory.nukeThreatScans && Memory.nukeThreatScans[targetRoom]) {
        delete Memory.nukeThreatScans[targetRoom];
        console.log('[NukeThreatCancel] Scan for ' + targetRoom + ' cancelled and removed from memory.');
    } else {
        console.log('[NukeThreatCancel] No active scan found for ' + targetRoom + '.');
    }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    nukeAnalyze:               nukeAnalyze,
    nukeAnalyzeSelf:           nukeAnalyzeSelf,
    nukeAnalyzeCost:           nukeAnalyzeCost,
    nukeIncoming:              nukeIncoming,
    nukeThreat:                nukeThreat,
    nukeThreatStatus:          nukeThreatStatus,
    nukeThreatCancel:          nukeThreatCancel,
    processPendingNukeAnalyze: processPendingNukeAnalyze
};