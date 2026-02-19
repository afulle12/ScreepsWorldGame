/**
 * Room Intelligence Module
 * Console command: intel('ROOM_NAME')
 * Analyzes a room and provides scores across three categories:
 * - Economic (25%)
 * - Military (30%)
 * - Dual Purpose (45%)
 * 
 * Results are cached in Memory.roomIntel and auto-cleared after 1000 ticks
 *
 * Observer fallback chain:
 *   1. Structural observer within 10 rooms (instant)
 *   2. Operator with PWR_OPERATE_OBSERVER + observer in its room (2-tick delay)
 *   3. Manual scouting required
 */

const CATEGORY_WEIGHTS = {
    economic: 0.25,
    military: 0.30,
    dualPurpose: 0.45
};

// Extension counts by RCL
const EXTENSIONS_BY_RCL = {
    0: 0, 1: 0, 2: 5, 3: 10, 4: 20, 5: 30, 6: 40, 7: 50, 8: 60
};

// Spawn counts by RCL
const SPAWNS_BY_RCL = {
    0: 0, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 2, 8: 3
};

/**
 * Main intel function - call from console as intel('W1N1')
 */
function intel(roomName) {
    if (!roomName || typeof roomName !== 'string') {
        console.log('[Intel] ERROR: Please provide a valid room name. Usage: intel("W1N1")');
        return null;
    }

    // Initialize memory storage
    if (!Memory.roomIntel) {
        Memory.roomIntel = {};
    }
    if (!Memory.roomIntelPending) {
        Memory.roomIntelPending = {};
    }

    const room = Game.rooms[roomName];
    
    // If room is not visible, try to use an observer (structural or power-boosted)
    if (!room) {
        // Check if we already scheduled observation last tick
        const pending = Memory.roomIntelPending[roomName];
        if (pending && Game.time - pending.tick <= 1) {
            // We scheduled last tick but still no visibility - observer might be out of range or room issue
            const via = pending.poweredObserver ? ' (PWR_OPERATE_OBSERVER)' : '';
            console.log('[Intel] ERROR: Room ' + roomName + ' still not visible after observation' + via + '. Observer may be out of range.');
            delete Memory.roomIntelPending[roomName];
            return null;
        }

        // Check if there's already a power-observe request in flight
        if (Memory.intelPowerObserve && Memory.intelPowerObserve[roomName]) {
            const poReq = Memory.intelPowerObserve[roomName];
            if (Game.time - poReq.tick <= 50) {
                const phase = poReq.phase || 'power';
                const elapsed = Game.time - poReq.tick;
                console.log('[Intel] ⏳ PWR_OPERATE_OBSERVER in progress — phase: ' + phase + ', operator: ' + poReq.operatorName + ', elapsed: ' + elapsed + ' ticks. Will auto-complete when ready.');
                return { status: 'pending_power_observe', room: roomName, operatorName: poReq.operatorName, operatorRoom: poReq.operatorRoom, phase: phase };
            } else {
                // Stale request, clean up
                console.log('[Intel] Power-observe request for ' + roomName + ' timed out after 50 ticks.');
                delete Memory.intelPowerObserve[roomName];
            }
        }

        // --- Fallback 1: Structural observer within 10 rooms ---
        const observer = findObserverInRange(roomName);
        if (observer) {
            const result = observer.observeRoom(roomName);
            if (result === OK) {
                Memory.roomIntelPending[roomName] = { tick: Game.time, observerRoom: observer.room.name };
                console.log('[Intel] 🔭 Observing ' + roomName + ' from ' + observer.room.name + '. Run intel(\'' + roomName + '\') again next tick.');
                return { status: 'pending', room: roomName, observerRoom: observer.room.name };
            } else {
                console.log('[Intel] ERROR: Observer failed with code ' + result);
                return null;
            }
        }

        // --- Fallback 2: Operator with PWR_OPERATE_OBSERVER ---
        const roleOperator = require('roleOperator');
        const powerObs = roleOperator.findPowerObserver(roomName);
        if (powerObs) {
            if (!Memory.intelPowerObserve) Memory.intelPowerObserve = {};
            Memory.intelPowerObserve[roomName] = {
                operatorName: powerObs.operatorName,
                operatorRoom: powerObs.operatorRoom,
                observerId: powerObs.observerId,
                tick: Game.time
            };
            console.log('[Intel] 🔭⚡ Requesting PWR_OPERATE_OBSERVER from ' + powerObs.operatorName + ' in ' + powerObs.operatorRoom + '. intel(\'' + roomName + '\') will auto-complete in ~3 ticks (power → observe → report).');
            return { status: 'pending_power_observe', room: roomName, operatorName: powerObs.operatorName, operatorRoom: powerObs.operatorRoom };
        }

        // --- No option available ---
        console.log('[Intel] ERROR: Room ' + roomName + ' is not visible. No observer in range and no operator with PWR_OPERATE_OBSERVER. Send a scout.');
        return null;
    }

    // Clear any pending status since we have visibility now
    delete Memory.roomIntelPending[roomName];

    // Gather all data
    const economicData = analyzeEconomic(room);
    const militaryData = analyzeMilitary(room);
    const dualPurposeData = analyzeDualPurpose(room);

    // Calculate category scores (clamped 0-100)
    const economicScore = Math.max(0, Math.min(100, economicData.score));
    const militaryScore = Math.max(0, Math.min(100, militaryData.score));
    const dualPurposeScore = Math.max(0, Math.min(100, dualPurposeData.score));

    // Calculate overall score
    const overallScore = (
        economicScore * CATEGORY_WEIGHTS.economic +
        militaryScore * CATEGORY_WEIGHTS.military +
        dualPurposeScore * CATEGORY_WEIGHTS.dualPurpose
    );

    // Build result object
    const result = {
        room: roomName,
        owner: room.controller && room.controller.owner ? room.controller.owner.username : 'Unowned',
        rcl: room.controller ? room.controller.level : 0,
        tick: Game.time,
        expiresTick: Game.time + 1000,
        overall: Math.round(overallScore * 10) / 10,
        economic: {
            score: Math.round(economicScore * 10) / 10,
            rawScore: Math.round(economicData.score * 10) / 10,
            positives: economicData.positives,
            negatives: economicData.negatives,
            details: economicData.details
        },
        military: {
            score: Math.round(militaryScore * 10) / 10,
            rawScore: Math.round(militaryData.score * 10) / 10,
            positives: militaryData.positives,
            negatives: militaryData.negatives,
            details: militaryData.details
        },
        dualPurpose: {
            score: Math.round(dualPurposeScore * 10) / 10,
            rawScore: Math.round(dualPurposeData.score * 10) / 10,
            positives: dualPurposeData.positives,
            negatives: dualPurposeData.negatives,
            details: dualPurposeData.details
        }
    };

    // Save to memory
    Memory.roomIntel[roomName] = result;

    // Print report
    printReport(result);

    return result;
}

/**
 * Analyze Economic factors (25% of total)
 */
function analyzeEconomic(room) {
    let score = 0;
    const positives = {};
    const negatives = {};
    const details = {};

    // Get structures
    const factory = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_FACTORY })[0];
    const extractor = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_EXTRACTOR })[0];
    const storage = room.storage;
    const terminal = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TERMINAL })[0];
    const links = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_LINK });
    const labs = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_LAB });
    const containers = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_CONTAINER });
    const sources = room.find(FIND_SOURCES);
    const mineral = room.find(FIND_MINERALS)[0];

    // Collect all resources from storage and terminal for commodity checks
    const allResources = new Set();
    if (storage && storage.store) {
        Object.keys(storage.store).filter(r => storage.store[r] > 0).forEach(r => allResources.add(r));
    }
    if (terminal && terminal.store) {
        Object.keys(terminal.store).filter(r => terminal.store[r] > 0).forEach(r => allResources.add(r));
    }

    // === POSITIVE INDICATORS ===

    // Factory exists (5%)
    if (factory) {
        positives.factoryExists = 5;
        score += 5;
        details.factoryExists = true;

        // Factory level 1+ (5%) - binary, any level 1 or above
        const factoryLevel = factory.level || 0;
        if (factoryLevel >= 1) {
            positives.factoryLeveled = 5;
            score += 5;
        }
        details.factoryLevel = factoryLevel;
    } else {
        details.factoryExists = false;
        details.factoryLevel = 0;
    }

    // Extractor exists (3%)
    if (extractor) {
        positives.extractorExists = 3;
        score += 3;
        details.extractorExists = true;

        // Extractor active (7%) - creep actively harvesting OR mineral depleted (was harvested dry)
        let extractorActive = false;
        if (mineral) {
            const nearbyCreeps = mineral.pos.findInRange(FIND_CREEPS, 1);
            const mineralDepleted = mineral.mineralAmount === 0;
            extractorActive = nearbyCreeps.length > 0 || mineralDepleted;
        }
        if (extractorActive) {
            positives.extractorActive = 7;
            score += 7;
        }
        details.extractorActive = extractorActive;
    } else {
        details.extractorExists = false;
        details.extractorActive = false;
    }

    // Store mineral info for display (no points)
    if (mineral) {
        details.mineralType = mineral.mineralType;
        details.mineralAmount = mineral.mineralAmount;
    }

    // Storage/Terminal commodity diversity (13%) - 0-25 types = 0-100%
    const nonEnergyResources = new Set();
    allResources.forEach(r => { if (r !== RESOURCE_ENERGY) nonEnergyResources.add(r); });
    const diversityCount = nonEnergyResources.size;
    if (diversityCount > 0) {
        const diversityScore = Math.min(25, diversityCount) / 25 * 13;
        positives.storageDiversity = Math.round(diversityScore * 10) / 10;
        score += diversityScore;
    }
    details.storageDiversityCount = diversityCount;

    // Link count (13%) - cap at 4 links (practical max needed)
    if (links.length > 0) {
        const linkScore = Math.min(links.length / 4, 1) * 13;
        positives.linkCount = Math.round(linkScore * 10) / 10;
        score += linkScore;
    }
    details.linkCount = links.length;

    // Labs present (5%) - 0-10 labs
    if (labs.length > 0) {
        const labScore = Math.min(labs.length / 10, 1) * 5;
        positives.labCount = Math.round(labScore * 10) / 10;
        score += labScore;
    }
    details.labCount = labs.length;

    // Labs actively running reactions (5%)
    const activeLabs = labs.filter(lab => lab.cooldown > 0 || (lab.mineralType && lab.store[lab.mineralType] > 0));
    if (activeLabs.length > 0 && labs.length > 0) {
        const activeLabScore = Math.min(activeLabs.length / labs.length, 1) * 5;
        positives.labsActive = Math.round(activeLabScore * 10) / 10;
        score += activeLabScore;
    }
    details.activeLabCount = activeLabs.length;

    // Market orders in room (10%) - room has active buy or sell orders
    const allOrders = Game.market.getAllOrders({ roomName: room.name });
    const roomOrders = allOrders.filter(o => o.roomName === room.name);
    const buyOrders = roomOrders.filter(o => o.type === ORDER_BUY);
    const sellOrders = roomOrders.filter(o => o.type === ORDER_SELL);
    details.marketBuyOrders = buyOrders.length;
    details.marketSellOrders = sellOrders.length;
    details.marketTotalOrders = roomOrders.length;

    // Collect sell order details for report display
    details.sellOrderDetails = sellOrders.map(o => ({
        resource: o.resourceType,
        amount: o.remainingAmount,
        price: o.price
    }));

    // Collect buy order details for report display
    details.buyOrderDetails = buyOrders.map(o => ({
        resource: o.resourceType,
        amount: o.remainingAmount,
        price: o.price
    }));
    
    if (roomOrders.length > 0) {
        positives.marketOrders = 10;
        score += 10;
    }

    // === COMMODITY CHECKS ===

    // Highway deposits (7%) - metal, biomass, silicon, mist
    const highwayDeposits = ['metal', 'biomass', 'silicon', 'mist'];
    const hasHighwayDeposits = highwayDeposits.some(r => allResources.has(r));
    if (hasHighwayDeposits) {
        positives.highwayDeposits = 7;
        score += 7;
    }
    details.hasHighwayDeposits = hasHighwayDeposits;

    // Compressed commodities (7%) - bars and battery
    const compressedCommodities = [
        'utrium_bar', 'lemergium_bar', 'zynthium_bar', 'keanium_bar',
        'ghodium_melt', 'oxidant', 'reductant', 'purifier', 'battery'
    ];
    const hasCompressed = compressedCommodities.some(r => allResources.has(r));
    if (hasCompressed) {
        positives.compressedCommodities = 7;
        score += 7;
    }
    details.hasCompressedCommodities = hasCompressed;

    // Regional commodities (7%) - wire, cell, alloy, condensate
    const regionalCommodities = ['wire', 'cell', 'alloy', 'condensate'];
    const hasRegional = regionalCommodities.some(r => allResources.has(r));
    if (hasRegional) {
        positives.regionalCommodities = 7;
        score += 7;
    }
    details.hasRegionalCommodities = hasRegional;

    // Level 1-5 commodities (7%)
    const levelCommodities = [
        // Common factory-level products
        'composite', 'crystal', 'liquid',
        // Level 1
        'switch', 'phlegm', 'tube', 'concentrate',
        // Level 2
        'transistor', 'tissue', 'fixtures', 'extract',
        // Level 3
        'microchip', 'muscle', 'frame', 'spirit',
        // Level 4
        'circuit', 'organoid', 'hydraulics', 'emanation',
        // Level 5
        'device', 'organism', 'machine', 'essence'
    ];
    const hasLevelCommodities = levelCommodities.some(r => allResources.has(r));
    if (hasLevelCommodities) {
        positives.levelCommodities = 7;
        score += 7;
    }
    details.hasLevelCommodities = hasLevelCommodities;

    // Lab products (6%) - any compound (not base minerals or energy)
    const baseMinerals = ['H', 'O', 'U', 'L', 'K', 'Z', 'X', 'G', 'energy', 'power'];
    const labProducts = [
        // Tier 1 compounds
        'OH', 'ZK', 'UL', 'UH', 'UO', 'KH', 'KO', 'LH', 'LO', 'ZH', 'ZO', 'GH', 'GO',
        // Tier 2 compounds
        'UH2O', 'UHO2', 'KH2O', 'KHO2', 'LH2O', 'LHO2', 'ZH2O', 'ZHO2', 'GH2O', 'GHO2',
        // Tier 3 compounds (boosts)
        'XUH2O', 'XUHO2', 'XKH2O', 'XKHO2', 'XLH2O', 'XLHO2', 'XZH2O', 'XZHO2', 'XGH2O', 'XGHO2'
    ];
    const hasLabProducts = labProducts.some(r => allResources.has(r));
    if (hasLabProducts) {
        positives.labProducts = 6;
        score += 6;
    }
    details.hasLabProducts = hasLabProducts;

    // === NEGATIVE INDICATORS ===

    // Storage nearly full >90% (-10%)
    if (storage && storage.store) {
        const usedCapacity = storage.store.getUsedCapacity();
        const totalCapacity = storage.store.getCapacity();
        const fillPercent = usedCapacity / totalCapacity * 100;
        details.storageFillPercent = Math.round(fillPercent);
        if (fillPercent > 90) {
            negatives.storageNearlyFull = -10;
            score -= 10;
        }
    }

    // Energy decaying on ground >1k (-10%)
    const droppedEnergy = room.find(FIND_DROPPED_RESOURCES, { 
        filter: r => r.resourceType === RESOURCE_ENERGY 
    });
    const totalDroppedEnergy = droppedEnergy.reduce((sum, r) => sum + r.amount, 0);
    details.droppedEnergy = totalDroppedEnergy;
    if (totalDroppedEnergy > 1000) {
        negatives.energyDecaying = -10;
        score -= 10;
    }

    // Links all empty (-8%)
    if (links.length > 0) {
        const allLinksEmpty = links.every(link => link.store[RESOURCE_ENERGY] === 0);
        details.allLinksEmpty = allLinksEmpty;
        if (allLinksEmpty) {
            negatives.linksEmpty = -8;
            score -= 8;
        }
    }

    // No links or containers in range 3 of sources (-12%)
    let sourcesWithInfrastructure = 0;
    for (const source of sources) {
        const nearbyLinks = source.pos.findInRange(links, 3);
        const nearbyContainers = source.pos.findInRange(containers, 3);
        if (nearbyLinks.length > 0 || nearbyContainers.length > 0) {
            sourcesWithInfrastructure++;
        }
    }
    details.sourcesWithInfrastructure = sourcesWithInfrastructure;
    details.totalSources = sources.length;
    if (sources.length > 0 && sourcesWithInfrastructure < sources.length) {
        negatives.missingSourceInfrastructure = -12;
        score -= 12;
    }

    return { score, positives, negatives, details };
}

/**
 * Analyze Military factors (30% of total)
 */
function analyzeMilitary(room) {
    let score = 0;
    const positives = {};
    const negatives = {};
    const details = {};

    // Get structures
    const towers = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER });
    const nuker = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_NUKER })[0];
    const ramparts = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_RAMPART });
    const walls = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_WALL });
    const spawns = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_SPAWN });
    const storage = room.storage;
    const terminal = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TERMINAL })[0];
    const allDefenses = ramparts.concat(walls);

    // Get creeps
    const allCreeps = room.find(FIND_CREEPS);
    const hostileCreeps = room.find(FIND_HOSTILE_CREEPS);

    // === POSITIVE INDICATORS ===

    // Tower count (21%) - 0-6 towers
    if (towers.length > 0) {
        const towerCountScore = Math.min(towers.length / 6, 1) * 21;
        positives.towerCount = Math.round(towerCountScore * 10) / 10;
        score += towerCountScore;
    }
    details.towerCount = towers.length;

    // At least 1 tower protected by 10M+ rampart (1%)
    let towerProtected = false;
    for (const tower of towers) {
        const protectingRampart = ramparts.find(r => r.pos.isEqualTo(tower.pos) && r.hits >= 10000000);
        if (protectingRampart) {
            towerProtected = true;
            break;
        }
    }
    if (towerProtected) {
        positives.towerProtected = 1;
        score += 1;
    }
    details.towerProtected = towerProtected;

    // Nuker exists (3%)
    if (nuker) {
        positives.nukerExists = 3;
        score += 3;
        details.nukerExists = true;

        // Nuker ready to fire (6%)
        const nukerEnergy = nuker.store[RESOURCE_ENERGY] || 0;
        const nukerGhodium = nuker.store[RESOURCE_GHODIUM] || 0;
        const nukerMaxEnergy = nuker.store.getCapacity(RESOURCE_ENERGY);
        const nukerMaxGhodium = nuker.store.getCapacity(RESOURCE_GHODIUM);
        const nukerFull = nukerEnergy >= nukerMaxEnergy && nukerGhodium >= nukerMaxGhodium;
        const nukerCharging = (nukerEnergy > 0 || nukerGhodium > 0) && !nukerFull;
        
        if (nukerFull) {
            positives.nukerReady = 6;
            score += 6;
        }
        details.nukerReady = nukerFull;
        details.nukerCharging = nukerCharging;
        details.nukerEnergy = nukerEnergy;
        details.nukerGhodium = nukerGhodium;

        // Nuker protected by 10M+ rampart (1%)
        const nukerProtectingRampart = ramparts.find(r => r.pos.isEqualTo(nuker.pos) && r.hits >= 10000000);
        if (nukerProtectingRampart) {
            positives.nukerProtected = 1;
            score += 1;
        }
        details.nukerProtected = !!nukerProtectingRampart;
    } else {
        details.nukerExists = false;
        details.nukerProtected = false;
    }

    // Average rampart/wall strength (15%) - scaled to 300M hits
    if (allDefenses.length > 0) {
        const avgHits = allDefenses.reduce((sum, s) => sum + s.hits, 0) / allDefenses.length;
        // Scale: 300M hits = 100% of this category
        const strengthScore = Math.min(avgHits / 300000000, 1) * 15;
        positives.avgDefenseStrength = Math.round(strengthScore * 10) / 10;
        score += strengthScore;
        details.avgDefenseHits = Math.round(avgHits);
        details.minDefenseHits = Math.min(...allDefenses.map(s => s.hits));
        details.maxDefenseHits = Math.max(...allDefenses.map(s => s.hits));
    }
    details.rampartCount = ramparts.length;
    details.wallCount = walls.length;

    // Spawn protected by 10M+ rampart (6%)
    let spawnProtected = false;
    for (const spawn of spawns) {
        const protectingRampart = ramparts.find(r => r.pos.isEqualTo(spawn.pos) && r.hits >= 10000000);
        if (protectingRampart) {
            spawnProtected = true;
            break;
        }
    }
    if (spawnProtected) {
        positives.spawnProtected = 6;
        score += 6;
    }
    details.spawnProtected = spawnProtected;

    // Storage protected by 10M+ rampart (5%)
    let storageProtected = false;
    if (storage) {
        const protectingRampart = ramparts.find(r => r.pos.isEqualTo(storage.pos) && r.hits >= 10000000);
        storageProtected = !!protectingRampart;
    }
    if (storageProtected) {
        positives.storageProtected = 5;
        score += 5;
    }
    details.storageProtected = storageProtected;

    // Terminal protected by 10M+ rampart (5%)
    let terminalProtected = false;
    if (terminal) {
        const protectingRampart = ramparts.find(r => r.pos.isEqualTo(terminal.pos) && r.hits >= 10000000);
        terminalProtected = !!protectingRampart;
    }
    if (terminalProtected) {
        positives.terminalProtected = 5;
        score += 5;
    }
    details.terminalProtected = terminalProtected;

    // Storage energy % to 1M (6%)
    if (storage && storage.store) {
        const storageEnergy = storage.store[RESOURCE_ENERGY] || 0;
        const energyPercent = Math.min(storageEnergy / 1000000, 1) * 6;
        positives.storageEnergy = Math.round(energyPercent * 10) / 10;
        score += energyPercent;
        details.storageEnergy = storageEnergy;
    }

    // Boosted creeps present (5%)
    const boostedCreeps = allCreeps.filter(c => {
        return c.body.some(part => part.boost);
    });
    if (boostedCreeps.length > 0) {
        positives.boostedCreeps = 5;
        score += 5;
    }
    details.boostedCreepCount = boostedCreeps.length;

    // Combat boost compounds in labs/storage/terminal (15%) - scaled to 30k total
    // Attack: UH, UH2O, XUH2O
    // Ranged Attack: KO, KHO2, XKHO2
    // Heal: LO, LHO2, XLHO2
    const combatBoosts = ['UH', 'UH2O', 'XUH2O', 'KO', 'KHO2', 'XKHO2', 'LO', 'LHO2', 'XLHO2'];
    let totalCombatBoosts = 0;
    
    // Check storage
    if (storage && storage.store) {
        for (const boost of combatBoosts) {
            totalCombatBoosts += storage.store[boost] || 0;
        }
    }
    
    // Check terminal
    if (terminal && terminal.store) {
        for (const boost of combatBoosts) {
            totalCombatBoosts += terminal.store[boost] || 0;
        }
    }
    
    // Check labs
    const labs = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_LAB });
    for (const lab of labs) {
        if (lab.mineralType && combatBoosts.includes(lab.mineralType)) {
            totalCombatBoosts += lab.store[lab.mineralType] || 0;
        }
    }
    
    if (totalCombatBoosts > 0) {
        const boostScore = Math.min(totalCombatBoosts / 30000, 1) * 15;
        positives.combatBoostStockpile = Math.round(boostScore * 10) / 10;
        score += boostScore;
    }
    details.combatBoostTotal = totalCombatBoosts;

    // Room sign by owner (2%)
    if (room.controller && room.controller.sign) {
        const signOwner = room.controller.sign.username;
        const roomOwner = room.controller.owner ? room.controller.owner.username : null;
        if (signOwner && roomOwner && signOwner === roomOwner) {
            positives.ownerSign = 2;
            score += 2;
            details.signByOwner = true;
            details.signText = room.controller.sign.text;
        } else {
            details.signByOwner = false;
            details.signText = room.controller.sign.text;
            details.signOwner = signOwner;
        }
    } else {
        details.signByOwner = false;
    }

    // Safe mode available (4%)
    if (room.controller && room.controller.safeModeAvailable > 0) {
        positives.safeModeAvailable = 4;
        score += 4;
    }
    details.safeModeAvailable = room.controller ? room.controller.safeModeAvailable : 0;

    // Safe mode cooldown - score based on no cooldown (5%)
    if (room.controller && !room.controller.safeModeCooldown) {
        positives.safeModeReady = 5;
        score += 5;
    }
    details.safeModeCooldown = room.controller ? room.controller.safeModeCooldown : 0;
    details.safeModeActive = room.controller ? room.controller.safeMode : 0;

    // === NEGATIVE INDICATORS ===

    // Towers empty (0 energy) (-15%)
    const emptyTowers = towers.filter(t => t.store[RESOURCE_ENERGY] === 0);
    if (emptyTowers.length > 0) {
        negatives.towersEmpty = -15;
        score -= 15;
    }
    details.emptyTowerCount = emptyTowers.length;

    // Towers below 25% energy (-10%)
    const lowTowers = towers.filter(t => {
        const energyPercent = t.store[RESOURCE_ENERGY] / t.store.getCapacity(RESOURCE_ENERGY);
        return energyPercent < 0.25 && energyPercent > 0;
    });
    if (lowTowers.length > 0) {
        negatives.towersLowEnergy = -10;
        score -= 10;
    }
    details.lowEnergyTowerCount = lowTowers.length;

    // Any rampart below 100k hits (-12%)
    const weakRamparts = ramparts.filter(r => r.hits < 100000);
    if (weakRamparts.length > 0) {
        negatives.weakRamparts = -12;
        score -= 12;
    }
    details.weakRampartCount = weakRamparts.length;

    // Defense checks (mutually exclusive)
    details.totalDefenseCount = allDefenses.length;
    if (room.controller && room.controller.level >= 2) {
        if (walls.length === 0 && ramparts.length === 0) {
            // No walls AND no ramparts (-50%)
            negatives.noDefenses = -50;
            score -= 50;
        } else if (walls.length > 0 && ramparts.length === 0) {
            // Walls exist but no ramparts (-25%)
            negatives.noRamparts = -25;
            score -= 25;
        }
    }

    // Check if walls are effective (path from entrances to storage blocked)
    if (storage && allDefenses.length > 0) {
        const breachedEntrances = checkWallEffectiveness(room, storage, ramparts, walls);
        details.wallsEffective = breachedEntrances.length === 0;
        details.breachedEntrances = breachedEntrances.length;
        details.breachedDirections = breachedEntrances;
        
        if (breachedEntrances.length > 0) {
            negatives.wallsBreached = -15;
            score -= 15;
        }
    } else {
        details.wallsEffective = false;
        details.breachedEntrances = 0;
        details.breachedDirections = [];
    }

    // Check if path exists from entrance to controller (-10%)
    if (room.controller && allDefenses.length > 0) {
        const controllerBreached = checkPathToTarget(room, room.controller, ramparts, walls);
        details.controllerExposed = controllerBreached;
        if (controllerBreached) {
            negatives.controllerExposed = -10;
            score -= 10;
        }
    } else {
        details.controllerExposed = true; // No defenses means exposed
    }

    // Check if path exists from entrance to sources (-10%)
    const sources = room.find(FIND_SOURCES);
    let exposedSourceCount = 0;
    if (sources.length > 0 && allDefenses.length > 0) {
        for (const source of sources) {
            const sourceBreached = checkPathToTarget(room, source, ramparts, walls);
            if (sourceBreached) {
                exposedSourceCount++;
            }
        }
        details.exposedSourceCount = exposedSourceCount;
        details.totalSourceCount = sources.length;
        if (exposedSourceCount > 0) {
            negatives.sourcesExposed = -10;
            score -= 10;
        }
    } else {
        details.exposedSourceCount = sources.length; // No defenses means all exposed
        details.totalSourceCount = sources.length;
    }

    return { score, positives, negatives, details };
}

/**
 * Check if walls effectively block paths from room entrances to storage
 * Returns array of directions that have unblocked paths (breached)
 */
function checkWallEffectiveness(room, storage, ramparts, walls) {
    const breachedDirections = [];
    const terrain = room.getTerrain();
    
    // Build a set of wall/rampart positions for the cost matrix
    const defensePositions = new Set();
    for (const structure of ramparts.concat(walls)) {
        defensePositions.add(structure.pos.x + ',' + structure.pos.y);
    }
    
    // Define entrance sample points for each direction
    const entrances = {
        top: [],
        bottom: [],
        left: [],
        right: []
    };
    
    // Sample entrance points (every 5 tiles to save CPU)
    for (let i = 1; i < 49; i += 5) {
        // Top edge (y = 0)
        if (terrain.get(i, 0) !== TERRAIN_MASK_WALL) {
            entrances.top.push(new RoomPosition(i, 0, room.name));
        }
        // Bottom edge (y = 49)
        if (terrain.get(i, 49) !== TERRAIN_MASK_WALL) {
            entrances.bottom.push(new RoomPosition(i, 49, room.name));
        }
        // Left edge (x = 0)
        if (terrain.get(0, i) !== TERRAIN_MASK_WALL) {
            entrances.left.push(new RoomPosition(0, i, room.name));
        }
        // Right edge (x = 49)
        if (terrain.get(49, i) !== TERRAIN_MASK_WALL) {
            entrances.right.push(new RoomPosition(49, i, room.name));
        }
    }
    
    // Check each direction for a valid path
    for (const direction in entrances) {
        const points = entrances[direction];
        let pathExists = false;
        
        for (const entrance of points) {
            // Use PathFinder with walls/ramparts as impassable
            const result = PathFinder.search(entrance, { pos: storage.pos, range: 1 }, {
                plainCost: 1,
                swampCost: 5,
                roomCallback: function(roomName) {
                    if (roomName !== room.name) return false;
                    
                    const costs = new PathFinder.CostMatrix();
                    
                    // Mark walls and ramparts as impassable
                    for (const structure of ramparts.concat(walls)) {
                        costs.set(structure.pos.x, structure.pos.y, 255);
                    }
                    
                    return costs;
                },
                maxRooms: 1
            });
            
            // If path found and it's complete (not incomplete), walls are breached
            if (!result.incomplete && result.path.length > 0) {
                pathExists = true;
                break;
            }
        }
        
        if (pathExists) {
            breachedDirections.push(direction);
        }
    }
    
    return breachedDirections;
}

/**
 * Check if a path exists from any entrance to a target (controller or source)
 * Returns true if path exists (target is exposed), false if blocked
 */
function checkPathToTarget(room, target, ramparts, walls) {
    const terrain = room.getTerrain();
    
    // Sample entrance points from all edges (every 5 tiles to save CPU)
    const entrances = [];
    for (let i = 1; i < 49; i += 5) {
        if (terrain.get(i, 0) !== TERRAIN_MASK_WALL) {
            entrances.push(new RoomPosition(i, 0, room.name));
        }
        if (terrain.get(i, 49) !== TERRAIN_MASK_WALL) {
            entrances.push(new RoomPosition(i, 49, room.name));
        }
        if (terrain.get(0, i) !== TERRAIN_MASK_WALL) {
            entrances.push(new RoomPosition(0, i, room.name));
        }
        if (terrain.get(49, i) !== TERRAIN_MASK_WALL) {
            entrances.push(new RoomPosition(49, i, room.name));
        }
    }
    
    // Check if any entrance has a path to the target
    for (const entrance of entrances) {
        const result = PathFinder.search(entrance, { pos: target.pos, range: 1 }, {
            plainCost: 1,
            swampCost: 5,
            roomCallback: function(roomName) {
                if (roomName !== room.name) return false;
                
                const costs = new PathFinder.CostMatrix();
                
                // Mark walls and ramparts as impassable
                for (const structure of ramparts.concat(walls)) {
                    costs.set(structure.pos.x, structure.pos.y, 255);
                }
                
                return costs;
            },
            maxRooms: 1
        });
        
        // If path found and it's complete, target is exposed
        if (!result.incomplete && result.path.length > 0) {
            return true;
        }
    }
    
    return false;
}

/**
 * Analyze Dual Purpose factors (45% of total)
 */
function analyzeDualPurpose(room) {
    let score = 0;
    const positives = {};
    const negatives = {};
    const details = {};

    const rcl = room.controller ? room.controller.level : 0;

    // Get structures
    const spawns = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_SPAWN });
    const extensions = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_EXTENSION });
    const powerSpawn = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_POWER_SPAWN })[0];
    const terminal = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TERMINAL })[0];
    const storage = room.storage;
    const observer = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_OBSERVER })[0];

    // Get creeps
    const allCreeps = room.find(FIND_CREEPS);
    const myCreeps = room.find(FIND_MY_CREEPS);
    const powerCreeps = room.find(FIND_POWER_CREEPS);

    // === POSITIVE INDICATORS ===

    // Room Controller Level (17%) - scaled 1-8
    if (rcl > 0) {
        const rclScore = (rcl / 8) * 17;
        positives.rcl = Math.round(rclScore * 10) / 10;
        score += rclScore;
    }
    details.rcl = rcl;

    // Spawn count (14%) - 0-3 spawns
    if (spawns.length > 0) {
        const spawnScore = Math.min(spawns.length / 3, 1) * 14;
        positives.spawnCount = Math.round(spawnScore * 10) / 10;
        score += spawnScore;
    }
    details.spawnCount = spawns.length;
    details.maxSpawns = SPAWNS_BY_RCL[rcl] || 0;

    // Max extensions for RCL (10%)
    const expectedExtensions = EXTENSIONS_BY_RCL[rcl] || 0;
    if (expectedExtensions > 0 && extensions.length >= expectedExtensions) {
        positives.maxExtensions = 10;
        score += 10;
    } else if (extensions.length > 0) {
        const extScore = (extensions.length / expectedExtensions) * 10;
        positives.extensionProgress = Math.round(extScore * 10) / 10;
        score += extScore;
    }
    details.extensionCount = extensions.length;
    details.expectedExtensions = expectedExtensions;

    // Power spawn exists (6%)
    if (powerSpawn) {
        positives.powerSpawnExists = 6;
        score += 6;
        details.powerSpawnExists = true;

        // Power spawn has energy (3%)
        const hasEnergy = powerSpawn.store[RESOURCE_ENERGY] > 0;
        if (hasEnergy) {
            positives.powerSpawnFueled = 3;
            score += 3;
        }
        details.powerSpawnEnergy = powerSpawn.store[RESOURCE_ENERGY];
        details.powerSpawnPower = powerSpawn.store[RESOURCE_POWER];
    } else {
        details.powerSpawnExists = false;
    }

    // Power resource found in room (1%) - in storage, terminal, or power spawn
    let powerInRoom = 0;
    if (storage && storage.store) {
        powerInRoom += storage.store[RESOURCE_POWER] || 0;
    }
    if (terminal && terminal.store) {
        powerInRoom += terminal.store[RESOURCE_POWER] || 0;
    }
    if (powerSpawn && powerSpawn.store) {
        powerInRoom += powerSpawn.store[RESOURCE_POWER] || 0;
    }
    if (powerInRoom > 0) {
        positives.powerInRoom = 1;
        score += 1;
    }
    details.powerInRoom = powerInRoom;

    // Terminal exists (8%)
    if (terminal) {
        positives.terminalExists = 8;
        score += 8;
        details.terminalExists = true;

        // Terminal has 1k+ energy (3%)
        const terminalEnergy = terminal.store[RESOURCE_ENERGY] || 0;
        if (terminalEnergy >= 1000) {
            positives.terminalHasEnergy = 3;
            score += 3;
        }
        details.terminalEnergy = terminalEnergy;

        // Terminal has non-energy resources (5%)
        const terminalResources = Object.keys(terminal.store).filter(r => r !== RESOURCE_ENERGY && terminal.store[r] > 0);
        if (terminalResources.length > 0) {
            positives.terminalHasResources = 5;
            score += 5;
        }
        details.terminalResourceCount = terminalResources.length;
    } else {
        details.terminalExists = false;
    }

    // Storage exists (8%)
    if (storage) {
        positives.storageExists = 8;
        score += 8;
        details.storageExists = true;
        details.storageTotalUsed = storage.store.getUsedCapacity();
    } else {
        details.storageExists = false;
    }

    // Large creeps 30+ parts (8%)
    const largeCreeps = allCreeps.filter(c => c.body.length >= 30);
    if (largeCreeps.length > 0) {
        positives.largeCreeps = 8;
        score += 8;
    }
    details.largeCreepCount = largeCreeps.length;
    details.maxCreepSize = allCreeps.length > 0 ? Math.max(...allCreeps.map(c => c.body.length)) : 0;

    // Power creeps present (6%)
    if (powerCreeps.length > 0) {
        positives.powerCreeps = 6;
        score += 6;
    }
    details.powerCreepCount = powerCreeps.length;

    // Observer present (6%)
    if (observer) {
        positives.observer = 6;
        score += 6;
    }
    details.observerExists = !!observer;

    // Downgrade timer - only tracked if below 100k (informational)
    details.downgradeTimer = room.controller ? room.controller.ticksToDowngrade : 0;

    // Has Hauler/Supplier (5%) - any creep in room with 30+ parts that only has MOVE and CARRY
    // Uses allCreeps (not myCreeps) so it works on enemy rooms too
    const haulers = allCreeps.filter(c => {
        if (c.body.length < 30) return false;
        return c.body.every(part => part.type === MOVE || part.type === CARRY);
    });
    if (haulers.length > 0) {
        positives.hasHauler = 5;
        score += 5;
    }
    details.haulerCount = haulers.length;

    // Track creep counts for display
    details.myCreepCount = myCreeps.length;
    details.totalCreepCount = allCreeps.length;

    // === NEGATIVE INDICATORS ===

    // Controller downgrade timer < 50k ticks (-15%)
    if (room.controller && room.controller.ticksToDowngrade && room.controller.ticksToDowngrade < 50000) {
        negatives.lowDowngradeTimer = -15;
        score -= 15;
    }
    // Controller downgrade timer < 100k ticks (-8%) - less severe warning
    else if (room.controller && room.controller.ticksToDowngrade && room.controller.ticksToDowngrade < 100000) {
        negatives.mediumDowngradeTimer = -8;
        score -= 8;
    }

    // Extension energy levels
    details.extensionEnergyPercent = 100; // Default to 100% if no extensions
    if (extensions.length > 0) {
        const totalExtEnergy = extensions.reduce((sum, e) => sum + e.store[RESOURCE_ENERGY], 0);
        const totalExtCapacity = extensions.reduce((sum, e) => sum + e.store.getCapacity(RESOURCE_ENERGY), 0);
        const extEnergyPercent = totalExtCapacity > 0 ? (totalExtEnergy / totalExtCapacity) * 100 : 0;
        details.extensionEnergyPercent = Math.round(extEnergyPercent);

        if (totalExtEnergy === 0) {
            negatives.extensionsEmpty = -12;
            score -= 12;
        } else if (extEnergyPercent < 25) {
            negatives.extensionsCritical = -8;
            score -= 8;
        } else if (extEnergyPercent < 50) {
            negatives.extensionsLow = -5;
            score -= 5;
        }
    }

    // Missing spawns for RCL (-12%)
    const expectedSpawns = SPAWNS_BY_RCL[rcl] || 0;
    if (spawns.length < expectedSpawns) {
        negatives.missingSpawns = -12;
        score -= 12;
    }
    details.missingSpawns = Math.max(0, expectedSpawns - spawns.length);

    // Missing extensions for RCL (-10%)
    if (extensions.length < expectedExtensions && expectedExtensions > 0) {
        negatives.missingExtensions = -10;
        score -= 10;
    }
    details.missingExtensions = Math.max(0, expectedExtensions - extensions.length);

    // Storage nearly empty <10k total (-10%)
    if (storage && storage.store.getUsedCapacity() < 10000) {
        negatives.storageEmpty = -10;
        score -= 10;
    }

    // No storage at RCL4+ (-15%)
    if (rcl >= 4 && !storage) {
        negatives.noStorage = -15;
        score -= 15;
    }

    return { score, positives, negatives, details };
}

/**
 * Find an observer that can reach the target room (within 10 room range)
 */
function findObserverInRange(targetRoomName) {
    // Parse target room coordinates
    const targetCoords = parseRoomName(targetRoomName);
    if (!targetCoords) return null;

    let bestObserver = null;
    let bestDistance = Infinity;

    // Search all my rooms for observers
    for (const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if (!room.controller || !room.controller.my) continue;

        const observers = room.find(FIND_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_OBSERVER
        });

        for (const observer of observers) {
            const obsCoords = parseRoomName(roomName);
            if (!obsCoords) continue;

            // Calculate room distance (Chebyshev distance)
            const dx = Math.abs(targetCoords.x - obsCoords.x);
            const dy = Math.abs(targetCoords.y - obsCoords.y);
            const distance = Math.max(dx, dy);

            // Observer range is 10 rooms
            if (distance <= OBSERVER_RANGE && distance < bestDistance) {
                bestObserver = observer;
                bestDistance = distance;
            }
        }
    }

    return bestObserver;
}

/**
 * Parse room name into coordinates
 */
function parseRoomName(roomName) {
    const match = roomName.match(/^([WE])(\d+)([NS])(\d+)$/);
    if (!match) return null;

    let x = parseInt(match[2]);
    let y = parseInt(match[4]);

    if (match[1] === 'W') x = -x - 1;
    if (match[3] === 'S') y = -y - 1;

    return { x, y };
}

/**
 * Print a compact report to the console (single log for clean copy/paste)
 */
function printReport(result) {
    const div = '════════════════════════════════════════════════════════════════════════════════';
    const lines = [];

    lines.push(div);
    lines.push('ROOM INTEL: ' + result.room + ' | Owner: ' + result.owner + ' | RCL: ' + result.rcl + ' | ' + getScoreRating(result.overall) + ' | OVERALL: ' + result.overall.toFixed(1) + '/100');
    lines.push(div);

    // === ECONOMIC ===
    const ecoPos = Object.keys(result.economic.positives).map(k => formatKeyShort(k) + ':+' + result.economic.positives[k]).join(', ');
    const ecoNeg = Object.keys(result.economic.negatives).map(k => formatKeyShort(k) + ':' + result.economic.negatives[k]).join(', ');
    lines.push('📊 ECONOMIC: ' + result.economic.score.toFixed(1) + '/100');
    lines.push('   Positives: [' + ecoPos + ']' + (ecoNeg ? ' | Negatives: [' + ecoNeg + ']' : ''));
    lines.push('   Factory: Level ' + (result.economic.details.factoryLevel || 0) + ' | Extractor: ' + (result.economic.details.extractorExists ? 'Yes' : 'No') + ' (' + (result.economic.details.extractorActive ? 'Active' : 'Idle') + ')');
    lines.push('   Labs: ' + result.economic.details.labCount + '/10 (' + result.economic.details.activeLabCount + ' active) | Links: ' + result.economic.details.linkCount + '/4');
    lines.push('   Storage Fill: ' + (result.economic.details.storageFillPercent || 0) + '% | Resource Diversity: ' + result.economic.details.storageDiversityCount + '/25 | Mineral: ' + (result.economic.details.mineralType || 'N/A'));
    lines.push('   Dropped Energy: ' + result.economic.details.droppedEnergy + ' | Market Orders: ' + (result.economic.details.marketTotalOrders || 0) + ' (' + (result.economic.details.marketBuyOrders || 0) + ' buy / ' + (result.economic.details.marketSellOrders || 0) + ' sell)');
    if (result.economic.details.sellOrderDetails && result.economic.details.sellOrderDetails.length > 0) {
        const sellList = result.economic.details.sellOrderDetails.map(function(o) {
            return o.resource + ' ×' + formatNumber(o.amount) + ' @' + o.price;
        }).join(', ');
        lines.push('   Selling: ' + sellList);
    }
    if (result.economic.details.buyOrderDetails && result.economic.details.buyOrderDetails.length > 0) {
        const buyList = result.economic.details.buyOrderDetails.map(function(o) {
            return o.resource + ' ×' + formatNumber(o.amount) + ' @' + o.price;
        }).join(', ');
        lines.push('   Buying: ' + buyList);
    }
    lines.push('   Commodities → Highway: ' + yn(result.economic.details.hasHighwayDeposits) + ' | Compressed: ' + yn(result.economic.details.hasCompressedCommodities) + ' | Regional: ' + yn(result.economic.details.hasRegionalCommodities) + ' | Lvl1-5: ' + yn(result.economic.details.hasLevelCommodities) + ' | Lab Products: ' + yn(result.economic.details.hasLabProducts));

    // === MILITARY ===
    const milPos = Object.keys(result.military.positives).map(k => formatKeyShort(k) + ':+' + result.military.positives[k]).join(', ');
    const milNeg = Object.keys(result.military.negatives).map(k => formatKeyShort(k) + ':' + result.military.negatives[k]).join(', ');
    lines.push('⚔️ MILITARY: ' + result.military.score.toFixed(1) + '/100');
    lines.push('   Positives: [' + milPos + ']' + (milNeg ? ' | Negatives: [' + milNeg + ']' : ''));
    lines.push('   Towers: ' + result.military.details.towerCount + '/6 (Empty: ' + result.military.details.emptyTowerCount + ', Low Energy: ' + result.military.details.lowEnergyTowerCount + ')');
    let nukerStatus = 'None';
    if (result.military.details.nukerExists) {
        if (result.military.details.nukerReady) {
            nukerStatus = 'READY TO FIRE';
        } else if (result.military.details.nukerCharging) {
            nukerStatus = 'Charging (' + formatNumber(result.military.details.nukerEnergy) + 'E / ' + formatNumber(result.military.details.nukerGhodium) + 'G)';
        } else {
            nukerStatus = 'Empty';
        }
    }
    lines.push('   Nuker: ' + nukerStatus + ' | Safe Mode: ' + result.military.details.safeModeAvailable + ' available');
    lines.push('   Walls: ' + result.military.details.wallCount + ' | Ramparts: ' + result.military.details.rampartCount + ' (Weak <100k: ' + result.military.details.weakRampartCount + ')');
    lines.push('   Defense Hits - Avg: ' + formatNumber(result.military.details.avgDefenseHits) + ' | Min: ' + formatNumber(result.military.details.minDefenseHits) + ' | Max: ' + formatNumber(result.military.details.maxDefenseHits));
    lines.push('   Protected by 10M+ Rampart → Spawn: ' + yn(result.military.details.spawnProtected) + ' | Storage: ' + yn(result.military.details.storageProtected) + ' | Terminal: ' + yn(result.military.details.terminalProtected) + ' | Tower: ' + yn(result.military.details.towerProtected) + ' | Nuker: ' + yn(result.military.details.nukerProtected));
    lines.push('   Boosted Creeps: ' + result.military.details.boostedCreepCount + ' | Combat Boost Stockpile: ' + formatNumber(result.military.details.combatBoostTotal) + '/30k');
    lines.push('   Signed by Owner: ' + yn(result.military.details.signByOwner));
    
    // Wall effectiveness
    let wallStatus = 'No storage/defenses';
    if (result.military.details.totalDefenseCount > 0 && result.military.details.wallsEffective !== undefined) {
        if (result.military.details.wallsEffective) {
            wallStatus = '✓ Effective (all entrances blocked)';
        } else if (result.military.details.breachedEntrances > 0) {
            wallStatus = '✗ BREACHED from: ' + result.military.details.breachedDirections.join(', ');
        } else {
            wallStatus = 'N/A';
        }
    }
    lines.push('   Wall Effectiveness: ' + wallStatus);
    lines.push('   Exposed to Entrance → Controller: ' + yn(result.military.details.controllerExposed) + ' | Sources: ' + result.military.details.exposedSourceCount + '/' + result.military.details.totalSourceCount);

    // === DUAL PURPOSE ===
    const dualPos = Object.keys(result.dualPurpose.positives).map(k => formatKeyShort(k) + ':+' + result.dualPurpose.positives[k]).join(', ');
    const dualNeg = Object.keys(result.dualPurpose.negatives).map(k => formatKeyShort(k) + ':' + result.dualPurpose.negatives[k]).join(', ');
    lines.push('🔧 DUAL PURPOSE: ' + result.dualPurpose.score.toFixed(1) + '/100');
    lines.push('   Positives: [' + dualPos + ']' + (dualNeg ? ' | Negatives: [' + dualNeg + ']' : ''));
    lines.push('   Spawns: ' + result.dualPurpose.details.spawnCount + '/' + result.dualPurpose.details.maxSpawns + ' | Extensions: ' + result.dualPurpose.details.extensionCount + '/' + result.dualPurpose.details.expectedExtensions + ' (' + (result.dualPurpose.details.extensionEnergyPercent || 0) + '% energy)');
    lines.push('   Storage: ' + formatNumber(result.dualPurpose.details.storageTotalUsed) + ' used | Terminal: ' + formatNumber(result.dualPurpose.details.terminalEnergy) + ' energy, ' + result.dualPurpose.details.terminalResourceCount + ' resource types');
    lines.push('   Power Spawn: ' + (result.dualPurpose.details.powerSpawnExists ? result.dualPurpose.details.powerSpawnEnergy + ' energy / ' + result.dualPurpose.details.powerSpawnPower + ' power' : 'None') + ' | Power in Room: ' + formatNumber(result.dualPurpose.details.powerInRoom) + ' | Observer: ' + yn(result.dualPurpose.details.observerExists));
    lines.push('   Creeps: ' + result.dualPurpose.details.myCreepCount + ' | Haulers (30+ MOVE/CARRY only): ' + result.dualPurpose.details.haulerCount + ' | Power Creeps: ' + result.dualPurpose.details.powerCreepCount);
    const downgradeDisplay = result.dualPurpose.details.downgradeTimer < 100000 ? formatNumber(result.dualPurpose.details.downgradeTimer) + ' ⚠️ LOW' : 'OK (>' + formatNumber(100000) + ')';
    lines.push('   Downgrade Timer: ' + downgradeDisplay);

    lines.push(div);
    lines.push('SUMMARY: ' + getSummary(result) + ' | Intel expires in ' + (result.expiresTick - Game.time) + ' ticks');
    lines.push(div);

    // Print as single log for clean copy/paste
    console.log(lines.join('\n'));
}

/**
 * Helper: Yes/No shorthand
 */
function yn(val) {
    return val ? 'Y' : 'N';
}

/**
 * Helper: Format number with k/M suffix
 */
function formatNumber(num) {
    if (num === undefined || num === null) return '0';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
    return String(num);
}

/**
 * Helper: Short key format for compact display
 */
function formatKeyShort(key) {
    const shortNames = {
        // Economic positives
        factoryExists: 'Fac',
        factoryLeveled: 'FacLvl',
        extractorExists: 'Ext',
        extractorActive: 'ExtAct',
        storageDiversity: 'Div',
        linkCount: 'Links',
        labCount: 'Labs',
        labsActive: 'LabAct',
        marketOrders: 'Market',
        highwayDeposits: 'Highway',
        compressedCommodities: 'Compressed',
        regionalCommodities: 'Regional',
        levelCommodities: 'LvlCommod',
        labProducts: 'LabProd',
        // Economic negatives
        storageNearlyFull: 'StoFull',
        energyDecaying: 'Decay',
        linksEmpty: 'LinkEmpty',
        missingSourceInfrastructure: 'NoSrcInf',
        // Military positives
        towerCount: 'Twr',
        towerProtected: 'TwrProt',
        nukerExists: 'Nuke',
        nukerReady: 'NukeRdy',
        nukerProtected: 'NukeProt',
        avgDefenseStrength: 'DefStr',
        spawnProtected: 'SpwnProt',
        storageProtected: 'StoProt',
        terminalProtected: 'TermProt',
        storageEnergy: 'StoE',
        boostedCreeps: 'Boost',
        combatBoostStockpile: 'BoostStock',
        ownerSign: 'Sign',
        safeModeAvailable: 'SafeAvl',
        safeModeReady: 'SafeRdy',
        // Military negatives
        towersEmpty: 'TwrEmpty',
        towersLowEnergy: 'TwrLow',
        weakRamparts: 'WeakRamp',
        noDefenses: 'NoDef',
        noRamparts: 'NoRamp',
        wallsBreached: 'Breached',
        controllerExposed: 'CtrlExp',
        sourcesExposed: 'SrcExp',
        // Dual purpose positives
        rcl: 'RCL',
        spawnCount: 'Spwn',
        maxExtensions: 'MaxExt',
        extensionProgress: 'ExtProg',
        powerSpawnExists: 'PSpwn',
        powerSpawnFueled: 'PSpwnE',
        powerInRoom: 'PwrInRoom',
        terminalExists: 'Term',
        terminalHasEnergy: 'TermE',
        terminalHasResources: 'TermRes',
        storageExists: 'Sto',
        largeCreeps: 'BigCreep',
        powerCreeps: 'PCreep',
        observer: 'Obs',
        hasHauler: 'Hauler',
        // Dual purpose negatives
        lowDowngradeTimer: 'LowDg',
        mediumDowngradeTimer: 'MedDg',
        missingSpawns: 'NoSpwn',
        missingExtensions: 'NoExt',
        storageEmpty: 'StoEmpty',
        noStorage: 'NoSto',
        extensionsEmpty: 'ExtEmpty',
        extensionsCritical: 'ExtCrit',
        extensionsLow: 'ExtLow'
    };
    return shortNames[key] || key;
}

/**
 * Helper: Get score rating text
 */
function getScoreRating(score) {
    if (score >= 90) return '⭐ ELITE';
    if (score >= 75) return '🟢 STRONG';
    if (score >= 60) return '🟡 DEVELOPED';
    if (score >= 45) return '🟠 MODERATE';
    if (score >= 30) return '🔴 WEAK';
    if (score >= 15) return '⚫ STRUGGLING';
    return '💀 CRITICAL';
}

/**
 * Helper: Generate summary text
 */
function getSummary(result) {
    const summaryParts = [];

    // Economic assessment
    if (result.economic.score >= 70) {
        summaryParts.push('Strong economy');
    } else if (result.economic.score >= 40) {
        summaryParts.push('Moderate economy');
    } else {
        summaryParts.push('Weak economy');
    }

    // Military assessment
    if (result.military.score >= 70) {
        summaryParts.push('well-defended');
    } else if (result.military.score >= 40) {
        summaryParts.push('some defenses');
    } else {
        summaryParts.push('poorly defended');
    }

    // Infrastructure assessment
    if (result.dualPurpose.score >= 70) {
        summaryParts.push('mature infrastructure');
    } else if (result.dualPurpose.score >= 40) {
        summaryParts.push('developing infrastructure');
    } else {
        summaryParts.push('limited infrastructure');
    }

    // Negatives
    const totalNegatives = 
        Object.keys(result.economic.negatives).length +
        Object.keys(result.military.negatives).length +
        Object.keys(result.dualPurpose.negatives).length;

    if (totalNegatives > 5) {
        summaryParts.push('MULTIPLE VULNERABILITIES');
    } else if (totalNegatives > 2) {
        summaryParts.push('some vulnerabilities');
    }

    return summaryParts.join(', ');
}

/**
 * Clean up expired intel from Memory
 */
function cleanExpiredIntel() {
    if (!Memory.roomIntel) return;

    const currentTick = Game.time;
    for (const roomName in Memory.roomIntel) {
        if (Memory.roomIntel[roomName].expiresTick <= currentTick) {
            delete Memory.roomIntel[roomName];
        }
    }

    // Also clean up old pending requests (older than 5 ticks)
    if (Memory.roomIntelPending) {
        for (const roomName in Memory.roomIntelPending) {
            if (Game.time - Memory.roomIntelPending[roomName].tick > 5) {
                delete Memory.roomIntelPending[roomName];
            }
        }
    }

    // Clean up stale power-observe requests (older than 50 ticks)
    if (Memory.intelPowerObserve) {
        for (const roomName in Memory.intelPowerObserve) {
            if (Game.time - Memory.intelPowerObserve[roomName].tick > 50) {
                delete Memory.intelPowerObserve[roomName];
            }
        }
    }
}

/**
 * Process pending intel requests (call from main loop to auto-complete observer requests)
 */
function processPendingIntel() {
    if (!Memory.roomIntelPending) return;

    for (const roomName in Memory.roomIntelPending) {
        const pending = Memory.roomIntelPending[roomName];
        
        // Only process if scheduled last tick (observer gives visibility this tick)
        if (Game.time - pending.tick === 1) {
            const room = Game.rooms[roomName];
            if (room) {
                const via = pending.poweredObserver ? ' (via PWR_OPERATE_OBSERVER)' : '';
                console.log('[Intel] 🔭 Auto-completing intel for ' + roomName + ' (observed from ' + pending.observerRoom + via + ')');
                intel(roomName);
            }
        }
    }
}

/**
 * Get cached intel for a room (if still valid)
 */
function getCachedIntel(roomName) {
    if (!Memory.roomIntel || !Memory.roomIntel[roomName]) {
        return null;
    }
    if (Memory.roomIntel[roomName].expiresTick <= Game.time) {
        delete Memory.roomIntel[roomName];
        return null;
    }
    return Memory.roomIntel[roomName];
}

/**
 * List all cached intel
 */
function listIntel() {
    if (!Memory.roomIntel || Object.keys(Memory.roomIntel).length === 0) {
        console.log('[Intel] No cached intel available.');
        return;
    }

    console.log('\n=== CACHED ROOM INTEL ===');
    for (const roomName in Memory.roomIntel) {
        const data = Memory.roomIntel[roomName];
        const ticksRemaining = data.expiresTick - Game.time;
        console.log(roomName + ': Overall ' + data.overall + '/100 | Owner: ' + data.owner + ' | Expires in ' + ticksRemaining + ' ticks');
    }
    console.log('=========================\n');
}

// Export for use in main.js and global console access
module.exports = {
    intel: intel,
    cleanExpiredIntel: cleanExpiredIntel,
    processPendingIntel: processPendingIntel,
    getCachedIntel: getCachedIntel,
    listIntel: listIntel,
    findObserverInRange: findObserverInRange
};