/**
 * playerAnalysis.js - Comprehensive player intelligence gathering
 * 
 * ═══════════════════════════════════════════════════════════════════
 * CONSOLE COMMANDS:
 * ═══════════════════════════════════════════════════════════════════
 * 
 *   player('PlayerName')   - Start full analysis of a player
 *                            Scans all rooms in observer range, finds
 *                            player's rooms, runs intel on each, and
 *                            generates comprehensive report
 * 
 *   playerStatus()         - Check progress of active analysis
 *                            Shows current phase, progress %, rooms found
 * 
 *   playerCancel()         - Cancel active analysis
 *                            Stops scanning/intel gathering immediately
 * 
 *   playerLast()           - View last analysis report
 *                            Reprints the full report from memory
 *                            Data expires after 10,000 ticks
 * 
 * ═══════════════════════════════════════════════════════════════════
 * 
 * This module will:
 * 1. Use wideScan to find all rooms owned by the target player
 * 2. Run intel on each room (suppressing normal output)
 * 3. Collect statistics and scores
 * 4. Generate a comprehensive report including:
 *    - Room strength classifications (weak/average/strong)
 *    - Aggregated player scores
 *    - Room statistics (energy, creeps, construction)
 *    - Nuclear strike capabilities (theirs vs ours)
 * 
 * INTEGRATION:
 *   const playerAnalysis = require('playerAnalysis');
 *   profiler.registerObject(playerAnalysis, 'playerAnalysis');
 *   // In main loop (MUST run every tick, no modulo):
 *   profileSection('playerAnalysis.run', function(){ playerAnalysis.run(); });
 */

const NUKE_RANGE = 5;
const OBSERVER_RANGE = 10;

// Score thresholds for classification
const SCORE_THRESHOLDS = {
    weak: 40,
    strong: 70
};

/**
 * Parse a room name into world coordinates
 */
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

/**
 * Convert world coordinates back to a room name
 */
function toRoomName(wx, wy) {
    let ew, ns, ewNum, nsNum;
    
    if (wx < 0) {
        ew = 'W';
        ewNum = -wx - 1;
    } else {
        ew = 'E';
        ewNum = wx;
    }
    
    if (wy < 0) {
        ns = 'N';
        nsNum = -wy - 1;
    } else {
        ns = 'S';
        nsNum = wy;
    }
    
    return `${ew}${ewNum}${ns}${nsNum}`;
}

/**
 * Calculate room distance (Chebyshev)
 */
function getRoomDistance(room1, room2) {
    const c1 = parseRoomName(room1);
    const c2 = parseRoomName(room2);
    if (!c1 || !c2) return Infinity;
    
    return Math.max(Math.abs(c1.wx - c2.wx), Math.abs(c1.wy - c2.wy));
}

/**
 * Check if room1 can nuke room2
 */
function canNuke(fromRoom, toRoom) {
    return getRoomDistance(fromRoom, toRoom) <= NUKE_RANGE;
}

/**
 * Get all my rooms with nukers
 */
function getMyNukerRooms() {
    const nukerRooms = [];
    
    for (const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if (!room.controller || !room.controller.my) continue;
        
        const nuker = room.find(FIND_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_NUKER
        })[0];
        
        if (nuker) {
            const nukerEnergy = nuker.store[RESOURCE_ENERGY] || 0;
            const nukerGhodium = nuker.store[RESOURCE_GHODIUM] || 0;
            const maxEnergy = nuker.store.getCapacity(RESOURCE_ENERGY);
            const maxGhodium = nuker.store.getCapacity(RESOURCE_GHODIUM);
            const isReady = nukerEnergy >= maxEnergy && nukerGhodium >= maxGhodium;
            const cooldown = nuker.cooldown || 0;
            
            nukerRooms.push({
                room: roomName,
                ready: isReady && cooldown === 0,
                energy: nukerEnergy,
                ghodium: nukerGhodium,
                cooldown: cooldown
            });
        }
    }
    
    return nukerRooms;
}

/**
 * Get all my rooms (for nuke target analysis)
 */
function getMyRooms() {
    const myRooms = [];
    
    for (const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if (room.controller && room.controller.my) {
            myRooms.push(roomName);
        }
    }
    
    return myRooms;
}

/**
 * Find all observers
 */
function getMyObservers() {
    const observerMap = {};
    
    for (const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if (!room.controller || !room.controller.my) continue;
        
        const observer = room.find(FIND_MY_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_OBSERVER
        })[0];
        
        if (observer) {
            observerMap[roomName] = observer;
        }
    }
    
    return observerMap;
}

/**
 * Get rooms in range of all observers
 */
function getRoomsInObserverRange() {
    const observerMap = getMyObservers();
    const roomSet = new Set();
    
    for (const observerRoom in observerMap) {
        const center = parseRoomName(observerRoom);
        if (!center) continue;
        
        for (let dx = -OBSERVER_RANGE; dx <= OBSERVER_RANGE; dx++) {
            for (let dy = -OBSERVER_RANGE; dy <= OBSERVER_RANGE; dy++) {
                if (dx === 0 && dy === 0) continue;
                const roomName = toRoomName(center.wx + dx, center.wy + dy);
                roomSet.add(roomName);
            }
        }
    }
    
    return Array.from(roomSet);
}

/**
 * Find best observer for a room
 */
function findObserverForRoom(targetRoom, observerMap) {
    const target = parseRoomName(targetRoom);
    if (!target) return null;
    
    for (const observerRoomName in observerMap) {
        const observerCoords = parseRoomName(observerRoomName);
        if (!observerCoords) continue;
        
        const distance = Math.max(
            Math.abs(target.wx - observerCoords.wx),
            Math.abs(target.wy - observerCoords.wy)
        );
        
        if (distance <= OBSERVER_RANGE) {
            return observerMap[observerRoomName];
        }
    }
    
    return null;
}

/**
 * Run intel silently and return data (no console output)
 */
function runIntelSilent(room) {
    // This is a condensed version of the intel analysis
    // We'll gather the same data but without printing
    
    const result = {
        room: room.name,
        owner: room.controller && room.controller.owner ? room.controller.owner.username : 'Unowned',
        rcl: room.controller ? room.controller.level : 0,
        tick: Game.time
    };
    
    // Get key structures
    const storage = room.storage;
    const terminal = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TERMINAL })[0];
    const towers = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER });
    const spawns = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_SPAWN });
    const extensions = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_EXTENSION });
    const nuker = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_NUKER })[0];
    const factory = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_FACTORY })[0];
    const labs = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_LAB });
    const ramparts = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_RAMPART });
    const walls = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_WALL });
    const powerSpawn = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_POWER_SPAWN })[0];
    const observer = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_OBSERVER })[0];
    const links = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_LINK });
    const containers = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_CONTAINER });
    const sources = room.find(FIND_SOURCES);
    const mineral = room.find(FIND_MINERALS)[0];
    const extractor = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_EXTRACTOR })[0];
    
    // Creeps
    const allCreeps = room.find(FIND_CREEPS);
    const hostileCreeps = room.find(FIND_HOSTILE_CREEPS);
    const myCreeps = room.find(FIND_MY_CREEPS);
    
    // === ECONOMIC SCORE ===
    let economicScore = 0;
    
    // Factory (5 + 5)
    if (factory) {
        economicScore += 5;
        if (factory.level >= 1) economicScore += 5;
    }
    
    // Extractor (3 + 7)
    if (extractor) {
        economicScore += 3;
        if (mineral) {
            const nearbyCreeps = mineral.pos.findInRange(FIND_CREEPS, 1);
            if (nearbyCreeps.length > 0 || mineral.mineralAmount === 0) {
                economicScore += 7;
            }
        }
    }
    
    // Storage diversity (13)
    const allResources = new Set();
    if (storage && storage.store) {
        Object.keys(storage.store).filter(r => storage.store[r] > 0 && r !== RESOURCE_ENERGY).forEach(r => allResources.add(r));
    }
    if (terminal && terminal.store) {
        Object.keys(terminal.store).filter(r => terminal.store[r] > 0 && r !== RESOURCE_ENERGY).forEach(r => allResources.add(r));
    }
    economicScore += Math.min(25, allResources.size) / 25 * 13;
    
    // Links (13)
    economicScore += Math.min(links.length / 4, 1) * 13;
    
    // Labs (5 + 5)
    economicScore += Math.min(labs.length / 10, 1) * 5;
    const activeLabs = labs.filter(lab => lab.cooldown > 0 || (lab.mineralType && lab.store[lab.mineralType] > 0));
    if (activeLabs.length > 0 && labs.length > 0) {
        economicScore += Math.min(activeLabs.length / labs.length, 1) * 5;
    }
    
    // Market orders (10)
    const roomOrders = Game.market.getAllOrders({ roomName: room.name });
    if (roomOrders.length > 0) economicScore += 10;
    
    // Commodities checks (7 each = 28 total + 6 lab)
    const highwayDeposits = ['metal', 'biomass', 'silicon', 'mist'];
    if (highwayDeposits.some(r => allResources.has(r))) economicScore += 7;
    
    const compressedCommodities = ['utrium_bar', 'lemergium_bar', 'zynthium_bar', 'keanium_bar', 'ghodium_melt', 'oxidant', 'reductant', 'purifier', 'battery'];
    if (compressedCommodities.some(r => allResources.has(r))) economicScore += 7;
    
    const regionalCommodities = ['wire', 'cell', 'alloy', 'condensate'];
    if (regionalCommodities.some(r => allResources.has(r))) economicScore += 7;
    
    const levelCommodities = ['switch', 'phlegm', 'tube', 'concentrate', 'transistor', 'tissue', 'fixtures', 'extract', 'microchip', 'muscle', 'frame', 'spirit', 'circuit', 'organoid', 'hydraulics', 'emanation', 'device', 'organism', 'machine', 'essence'];
    if (levelCommodities.some(r => allResources.has(r))) economicScore += 7;
    
    const labProducts = ['OH', 'ZK', 'UL', 'UH', 'UO', 'KH', 'KO', 'LH', 'LO', 'ZH', 'ZO', 'GH', 'GO', 'UH2O', 'UHO2', 'KH2O', 'KHO2', 'LH2O', 'LHO2', 'ZH2O', 'ZHO2', 'GH2O', 'GHO2', 'XUH2O', 'XUHO2', 'XKH2O', 'XKHO2', 'XLH2O', 'XLHO2', 'XZH2O', 'XZHO2', 'XGH2O', 'XGHO2'];
    if (labProducts.some(r => allResources.has(r))) economicScore += 6;
    
    // Economic negatives
    if (storage && storage.store) {
        const fillPercent = storage.store.getUsedCapacity() / storage.store.getCapacity() * 100;
        if (fillPercent > 90) economicScore -= 10;
    }
    
    const droppedEnergy = room.find(FIND_DROPPED_RESOURCES, { filter: r => r.resourceType === RESOURCE_ENERGY });
    const totalDropped = droppedEnergy.reduce((sum, r) => sum + r.amount, 0);
    if (totalDropped > 1000) economicScore -= 10;
    
    if (links.length > 0 && links.every(l => l.store[RESOURCE_ENERGY] === 0)) economicScore -= 8;
    
    let sourcesWithInfra = 0;
    for (const source of sources) {
        if (source.pos.findInRange(links, 3).length > 0 || source.pos.findInRange(containers, 3).length > 0) {
            sourcesWithInfra++;
        }
    }
    if (sources.length > 0 && sourcesWithInfra < sources.length) economicScore -= 12;
    
    // === MILITARY SCORE ===
    let militaryScore = 0;
    
    // Towers (21)
    militaryScore += Math.min(towers.length / 6, 1) * 21;
    
    // Tower protected (1)
    const towerProtected = towers.some(t => ramparts.find(r => r.pos.isEqualTo(t.pos) && r.hits >= 10000000));
    if (towerProtected) militaryScore += 1;
    
    // Nuker (3 + 6 + 1)
    let nukerReady = false;
    let nukerCharging = false;
    let nukerEnergy = 0;
    let nukerGhodium = 0;
    if (nuker) {
        militaryScore += 3;
        nukerEnergy = nuker.store[RESOURCE_ENERGY] || 0;
        nukerGhodium = nuker.store[RESOURCE_GHODIUM] || 0;
        const maxEnergy = nuker.store.getCapacity(RESOURCE_ENERGY);
        const maxGhodium = nuker.store.getCapacity(RESOURCE_GHODIUM);
        nukerReady = nukerEnergy >= maxEnergy && nukerGhodium >= maxGhodium;
        nukerCharging = (nukerEnergy > 0 || nukerGhodium > 0) && !nukerReady;
        if (nukerReady) militaryScore += 6;
        if (ramparts.find(r => r.pos.isEqualTo(nuker.pos) && r.hits >= 10000000)) militaryScore += 1;
    }
    
    // Defense strength (15)
    const allDefenses = ramparts.concat(walls);
    if (allDefenses.length > 0) {
        const avgHits = allDefenses.reduce((sum, s) => sum + s.hits, 0) / allDefenses.length;
        militaryScore += Math.min(avgHits / 300000000, 1) * 15;
    }
    
    // Protected structures (6 + 5 + 5)
    if (spawns.some(s => ramparts.find(r => r.pos.isEqualTo(s.pos) && r.hits >= 10000000))) militaryScore += 6;
    if (storage && ramparts.find(r => r.pos.isEqualTo(storage.pos) && r.hits >= 10000000)) militaryScore += 5;
    if (terminal && ramparts.find(r => r.pos.isEqualTo(terminal.pos) && r.hits >= 10000000)) militaryScore += 5;
    
    // Storage energy (6)
    if (storage && storage.store) {
        const storageEnergy = storage.store[RESOURCE_ENERGY] || 0;
        militaryScore += Math.min(storageEnergy / 1000000, 1) * 6;
    }
    
    // Boosted creeps (5)
    const boostedCreeps = allCreeps.filter(c => c.body.some(part => part.boost));
    if (boostedCreeps.length > 0) militaryScore += 5;
    
    // Combat boosts (15)
    const combatBoosts = ['UH', 'UH2O', 'XUH2O', 'KO', 'KHO2', 'XKHO2', 'LO', 'LHO2', 'XLHO2'];
    let totalCombatBoosts = 0;
    if (storage && storage.store) {
        for (const boost of combatBoosts) totalCombatBoosts += storage.store[boost] || 0;
    }
    if (terminal && terminal.store) {
        for (const boost of combatBoosts) totalCombatBoosts += terminal.store[boost] || 0;
    }
    for (const lab of labs) {
        if (lab.mineralType && combatBoosts.includes(lab.mineralType)) {
            totalCombatBoosts += lab.store[lab.mineralType] || 0;
        }
    }
    militaryScore += Math.min(totalCombatBoosts / 30000, 1) * 15;
    
    // Sign (2)
    if (room.controller && room.controller.sign) {
        const signOwner = room.controller.sign.username;
        const roomOwner = room.controller.owner ? room.controller.owner.username : null;
        if (signOwner === roomOwner) militaryScore += 2;
    }
    
    // Safe mode (4 + 5)
    if (room.controller && room.controller.safeModeAvailable > 0) militaryScore += 4;
    if (room.controller && !room.controller.safeModeCooldown) militaryScore += 5;
    
    // Military negatives
    const emptyTowers = towers.filter(t => t.store[RESOURCE_ENERGY] === 0);
    if (emptyTowers.length > 0) militaryScore -= 15;
    
    const lowTowers = towers.filter(t => {
        const pct = t.store[RESOURCE_ENERGY] / t.store.getCapacity(RESOURCE_ENERGY);
        return pct < 0.25 && pct > 0;
    });
    if (lowTowers.length > 0) militaryScore -= 10;
    
    const weakRamparts = ramparts.filter(r => r.hits < 100000);
    if (weakRamparts.length > 0) militaryScore -= 12;
    
    if (room.controller && room.controller.level >= 2) {
        if (walls.length === 0 && ramparts.length === 0) {
            militaryScore -= 50;
        } else if (walls.length > 0 && ramparts.length === 0) {
            militaryScore -= 25;
        }
    }
    
    // === DUAL PURPOSE SCORE ===
    let dualPurposeScore = 0;
    const rcl = room.controller ? room.controller.level : 0;
    
    // RCL (17)
    if (rcl > 0) dualPurposeScore += (rcl / 8) * 17;
    
    // Spawns (14)
    dualPurposeScore += Math.min(spawns.length / 3, 1) * 14;
    
    // Extensions (10)
    const EXTENSIONS_BY_RCL = { 0: 0, 1: 0, 2: 5, 3: 10, 4: 20, 5: 30, 6: 40, 7: 50, 8: 60 };
    const expectedExt = EXTENSIONS_BY_RCL[rcl] || 0;
    if (expectedExt > 0 && extensions.length >= expectedExt) {
        dualPurposeScore += 10;
    } else if (extensions.length > 0 && expectedExt > 0) {
        dualPurposeScore += (extensions.length / expectedExt) * 10;
    }
    
    // Power spawn (6 + 3 + 1)
    if (powerSpawn) {
        dualPurposeScore += 6;
        if (powerSpawn.store[RESOURCE_ENERGY] > 0) dualPurposeScore += 3;
    }
    let powerInRoom = 0;
    if (storage && storage.store) powerInRoom += storage.store[RESOURCE_POWER] || 0;
    if (terminal && terminal.store) powerInRoom += terminal.store[RESOURCE_POWER] || 0;
    if (powerSpawn && powerSpawn.store) powerInRoom += powerSpawn.store[RESOURCE_POWER] || 0;
    if (powerInRoom > 0) dualPurposeScore += 1;
    
    // Terminal (8 + 3 + 5)
    if (terminal) {
        dualPurposeScore += 8;
        const termEnergy = terminal.store[RESOURCE_ENERGY] || 0;
        if (termEnergy >= 1000) dualPurposeScore += 3;
        const termResources = Object.keys(terminal.store).filter(r => r !== RESOURCE_ENERGY && terminal.store[r] > 0);
        if (termResources.length > 0) dualPurposeScore += 5;
    }
    
    // Storage (8)
    if (storage) dualPurposeScore += 8;
    
    // Large creeps (8)
    const largeCreeps = allCreeps.filter(c => c.body.length >= 30);
    if (largeCreeps.length > 0) dualPurposeScore += 8;
    
    // Power creeps (6)
    const powerCreeps = room.find(FIND_POWER_CREEPS);
    if (powerCreeps.length > 0) dualPurposeScore += 6;
    
    // Observer (6)
    if (observer) dualPurposeScore += 6;
    
    // Haulers (5)
    const haulers = allCreeps.filter(c => c.body.length >= 30 && c.body.every(p => p.type === MOVE || p.type === CARRY));
    if (haulers.length > 0) dualPurposeScore += 5;
    
    // Dual purpose negatives
    if (room.controller && room.controller.ticksToDowngrade) {
        if (room.controller.ticksToDowngrade < 50000) dualPurposeScore -= 15;
        else if (room.controller.ticksToDowngrade < 100000) dualPurposeScore -= 8;
    }
    
    const SPAWNS_BY_RCL = { 0: 0, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 2, 8: 3 };
    const expectedSpawns = SPAWNS_BY_RCL[rcl] || 0;
    if (spawns.length < expectedSpawns) dualPurposeScore -= 12;
    if (extensions.length < expectedExt && expectedExt > 0) dualPurposeScore -= 10;
    
    if (storage && storage.store.getUsedCapacity() < 10000) dualPurposeScore -= 10;
    if (rcl >= 4 && !storage) dualPurposeScore -= 15;
    
    if (extensions.length > 0) {
        const totalExtEnergy = extensions.reduce((sum, e) => sum + e.store[RESOURCE_ENERGY], 0);
        const totalExtCap = extensions.reduce((sum, e) => sum + e.store.getCapacity(RESOURCE_ENERGY), 0);
        const extPct = totalExtCap > 0 ? totalExtEnergy / totalExtCap : 0;
        if (totalExtEnergy === 0) dualPurposeScore -= 12;
        else if (extPct < 0.25) dualPurposeScore -= 8;
        else if (extPct < 0.5) dualPurposeScore -= 5;
    }
    
    // Clamp scores
    economicScore = Math.max(0, Math.min(100, economicScore));
    militaryScore = Math.max(0, Math.min(100, militaryScore));
    dualPurposeScore = Math.max(0, Math.min(100, dualPurposeScore));
    
    // Overall score (weighted)
    const overallScore = economicScore * 0.25 + militaryScore * 0.30 + dualPurposeScore * 0.45;
    
    // Collect detailed data
    result.scores = {
        overall: Math.round(overallScore * 10) / 10,
        economic: Math.round(economicScore * 10) / 10,
        military: Math.round(militaryScore * 10) / 10,
        dualPurpose: Math.round(dualPurposeScore * 10) / 10
    };
    
    result.structures = {
        spawns: spawns.length,
        extensions: extensions.length,
        towers: towers.length,
        storage: !!storage,
        terminal: !!terminal,
        nuker: !!nuker,
        nukerReady: nukerReady,
        nukerCharging: nukerCharging,
        nukerEnergy: nukerEnergy,
        nukerGhodium: nukerGhodium,
        factory: !!factory,
        factoryLevel: factory ? factory.level || 0 : 0,
        labs: labs.length,
        powerSpawn: !!powerSpawn,
        observer: !!observer,
        ramparts: ramparts.length,
        walls: walls.length,
        links: links.length
    };
    
    result.resources = {
        storageEnergy: storage ? storage.store[RESOURCE_ENERGY] || 0 : 0,
        storageTotal: storage ? storage.store.getUsedCapacity() : 0,
        terminalEnergy: terminal ? terminal.store[RESOURCE_ENERGY] || 0 : 0,
        terminalTotal: terminal ? terminal.store.getUsedCapacity() : 0,
        power: powerInRoom,
        combatBoosts: totalCombatBoosts,
        resourceDiversity: allResources.size
    };
    
    result.defense = {
        avgDefenseHits: allDefenses.length > 0 ? Math.round(allDefenses.reduce((sum, s) => sum + s.hits, 0) / allDefenses.length) : 0,
        minDefenseHits: allDefenses.length > 0 ? Math.min(...allDefenses.map(s => s.hits)) : 0,
        maxDefenseHits: allDefenses.length > 0 ? Math.max(...allDefenses.map(s => s.hits)) : 0,
        weakRamparts: weakRamparts.length,
        safeModeAvailable: room.controller ? room.controller.safeModeAvailable || 0 : 0,
        safeModeCooldown: room.controller ? room.controller.safeModeCooldown || 0 : 0
    };
    
    result.creeps = {
        total: allCreeps.length,
        boosted: boostedCreeps.length,
        large: largeCreeps.length,
        maxSize: allCreeps.length > 0 ? Math.max(...allCreeps.map(c => c.body.length)) : 0,
        powerCreeps: powerCreeps.length
    };
    
    result.controller = {
        level: rcl,
        progress: room.controller ? room.controller.progress : 0,
        progressTotal: room.controller ? room.controller.progressTotal : 0,
        progressPercent: room.controller && room.controller.progressTotal > 0 ? 
            Math.round(room.controller.progress / room.controller.progressTotal * 1000) / 10 : 0,
        downgradeTimer: room.controller ? room.controller.ticksToDowngrade : 0
    };
    
    result.economy = {
        energyAvailable: room.energyAvailable,
        energyCapacity: room.energyCapacityAvailable,
        sources: sources.length,
        mineral: mineral ? mineral.mineralType : null,
        mineralAmount: mineral ? mineral.mineralAmount : 0
    };
    
    return result;
}

/**
 * Start player analysis
 */
function startPlayerAnalysis(playerName) {
    if (!playerName || typeof playerName !== 'string') {
        console.log('[PlayerAnalysis] ERROR: Please provide a player name. Usage: player("PlayerName")');
        return;
    }
    
    // Check if already running
    if (Memory.playerAnalysis && Memory.playerAnalysis.active) {
        console.log('[PlayerAnalysis] ERROR: Analysis already in progress for ' + Memory.playerAnalysis.targetPlayer);
        console.log('[PlayerAnalysis] Use playerCancel() to cancel the current analysis.');
        return;
    }
    
    // Get observers
    const observerMap = getMyObservers();
    const observerRooms = Object.keys(observerMap);
    
    if (observerRooms.length === 0) {
        console.log('[PlayerAnalysis] ERROR: No observers found. Cannot scan for player rooms.');
        return;
    }
    
    console.log('[PlayerAnalysis] Starting analysis of player: ' + playerName);
    console.log('[PlayerAnalysis] Found ' + observerRooms.length + ' observer(s)');
    
    // Get all rooms in observer range
    const allRooms = getRoomsInObserverRange();
    
    // Initialize state
    Memory.playerAnalysis = {
        active: true,
        phase: 'scanning',
        targetPlayer: playerName,
        startTick: Game.time,
        observerRooms: observerRooms,
        
        // Phase 1: Wide scan to find player rooms
        scanQueue: allRooms.slice(),
        scannedCount: 0,
        totalScanRooms: allRooms.length,
        foundRooms: [],
        lastObservedRoom: null,
        
        // Phase 2: Intel gathering
        intelQueue: [],
        intelResults: [],
        intelCount: 0,
        totalIntelRooms: 0
    };
    
    console.log('[PlayerAnalysis] Phase 1: Scanning ' + allRooms.length + ' rooms for ' + playerName + '\'s bases...');
    const scanMinutes = Math.ceil((allRooms.length * 3) / 60);
    console.log('[PlayerAnalysis] Estimated scan time: ~' + scanMinutes + ' minutes');
}

/**
 * Cancel player analysis
 */
function cancelPlayerAnalysis() {
    if (Memory.playerAnalysis && Memory.playerAnalysis.active) {
        console.log('[PlayerAnalysis] Analysis cancelled.');
        delete Memory.playerAnalysis;
    } else {
        console.log('[PlayerAnalysis] No active analysis to cancel.');
    }
}

/**
 * Get analysis status
 */
function getAnalysisStatus() {
    if (!Memory.playerAnalysis || !Memory.playerAnalysis.active) {
        console.log('[PlayerAnalysis] No active analysis.');
        return null;
    }
    
    const state = Memory.playerAnalysis;
    const elapsed = Game.time - state.startTick;
    
    console.log('[PlayerAnalysis] Status:');
    console.log('  Target: ' + state.targetPlayer);
    console.log('  Phase: ' + state.phase);
    
    if (state.phase === 'scanning') {
        const progress = ((state.scannedCount / state.totalScanRooms) * 100).toFixed(1);
        console.log('  Scan Progress: ' + state.scannedCount + '/' + state.totalScanRooms + ' (' + progress + '%)');
        console.log('  Rooms Found: ' + state.foundRooms.length);
    } else if (state.phase === 'intel') {
        const progress = ((state.intelCount / state.totalIntelRooms) * 100).toFixed(1);
        console.log('  Intel Progress: ' + state.intelCount + '/' + state.totalIntelRooms + ' (' + progress + '%)');
    }
    
    console.log('  Elapsed: ' + elapsed + ' ticks');
    
    return state;
}

/**
 * Run function - call every tick from main loop
 */
function run() {
    // Auto-clear expired analysis data
    if (Memory.lastPlayerAnalysis && Memory.lastPlayerAnalysis.expiresTick <= Game.time) {
        delete Memory.lastPlayerAnalysis;
    }
    
    if (!Memory.playerAnalysis || !Memory.playerAnalysis.active) return;
    
    const state = Memory.playerAnalysis;
    const observerMap = getMyObservers();
    
    if (state.phase === 'scanning') {
        runScanPhase(state, observerMap);
    } else if (state.phase === 'intel') {
        runIntelPhase(state, observerMap);
    }
}

/**
 * Phase 1: Scan for player rooms
 */
function runScanPhase(state, observerMap) {
    // Process room observed last tick
    if (state.lastObservedRoom) {
        const room = Game.rooms[state.lastObservedRoom];
        if (room) {
            if (room.controller && room.controller.owner && 
                room.controller.owner.username === state.targetPlayer) {
                if (!state.foundRooms.includes(state.lastObservedRoom)) {
                    state.foundRooms.push(state.lastObservedRoom);
                    console.log('[PlayerAnalysis] Found ' + state.targetPlayer + '\'s room: ' + state.lastObservedRoom + ' (RCL ' + room.controller.level + ')');
                }
            }
        }
        state.scannedCount++;
        state.lastObservedRoom = null;
    }
    
    // Check if scan complete
    if (state.scanQueue.length === 0) {
        console.log('[PlayerAnalysis] Phase 1 complete. Found ' + state.foundRooms.length + ' room(s).');
        
        if (state.foundRooms.length === 0) {
            console.log('[PlayerAnalysis] No rooms found for ' + state.targetPlayer + ' within observer range.');
            completeAnalysis(state);
            return;
        }
        
        // Move to intel phase
        state.phase = 'intel';
        state.intelQueue = state.foundRooms.slice();
        state.totalIntelRooms = state.foundRooms.length;
        console.log('[PlayerAnalysis] Phase 2: Gathering intel on ' + state.totalIntelRooms + ' room(s)...');
        return;
    }
    
    // Get next room to scan
    const nextRoom = state.scanQueue.shift();
    const observer = findObserverForRoom(nextRoom, observerMap);
    
    if (observer) {
        const result = observer.observeRoom(nextRoom);
        if (result === OK) {
            state.lastObservedRoom = nextRoom;
        } else {
            state.scannedCount++;
        }
    } else {
        state.scannedCount++;
    }
    
    // Progress update
    if (state.scannedCount > 0 && state.scannedCount % 100 === 0) {
        const progress = ((state.scannedCount / state.totalScanRooms) * 100).toFixed(1);
        console.log('[PlayerAnalysis] Scan progress: ' + state.scannedCount + '/' + state.totalScanRooms + ' (' + progress + '%) - Found ' + state.foundRooms.length + ' room(s)');
    }
}

/**
 * Phase 2: Gather intel on found rooms
 */
function runIntelPhase(state, observerMap) {
    // Process room observed last tick
    if (state.lastObservedRoom) {
        const room = Game.rooms[state.lastObservedRoom];
        if (room) {
            const intelData = runIntelSilent(room);
            state.intelResults.push(intelData);
        }
        state.intelCount++;
        state.lastObservedRoom = null;
    }
    
    // Check if intel complete
    if (state.intelQueue.length === 0) {
        console.log('[PlayerAnalysis] Phase 2 complete. Intel gathered on ' + state.intelResults.length + ' room(s).');
        completeAnalysis(state);
        return;
    }
    
    // Get next room for intel
    const nextRoom = state.intelQueue.shift();
    const observer = findObserverForRoom(nextRoom, observerMap);
    
    if (observer) {
        const result = observer.observeRoom(nextRoom);
        if (result === OK) {
            state.lastObservedRoom = nextRoom;
        } else {
            state.intelCount++;
        }
    } else {
        state.intelCount++;
    }
}

/**
 * Complete analysis and print report
 */
function completeAnalysis(state) {
    const elapsed = Game.time - state.startTick;
    const results = state.intelResults;
    const playerName = state.targetPlayer;
    
    // Calculate nuke capabilities
    const myNukers = getMyNukerRooms();
    const myRooms = getMyRooms();
    
    // Enemy rooms that can nuke my rooms
    const enemyNukeThreats = [];
    // My rooms that can nuke enemy rooms
    const myNukeTargets = [];
    
    for (const intel of results) {
        if (intel.structures.nuker) {
            // Check which of my rooms this enemy nuker can hit
            const threatenedRooms = myRooms.filter(r => canNuke(intel.room, r));
            if (threatenedRooms.length > 0) {
                enemyNukeThreats.push({
                    enemyRoom: intel.room,
                    ready: intel.structures.nukerReady,
                    charging: intel.structures.nukerCharging,
                    threatens: threatenedRooms
                });
            }
        }
        
        // Check which of my nukers can hit this enemy room
        for (const myNuker of myNukers) {
            if (canNuke(myNuker.room, intel.room)) {
                const existing = myNukeTargets.find(t => t.myRoom === myNuker.room);
                if (existing) {
                    existing.canHit.push(intel.room);
                } else {
                    myNukeTargets.push({
                        myRoom: myNuker.room,
                        ready: myNuker.ready,
                        canHit: [intel.room]
                    });
                }
            }
        }
    }
    
    // Classify rooms
    const weakRooms = results.filter(r => r.scores.overall < SCORE_THRESHOLDS.weak);
    const strongRooms = results.filter(r => r.scores.overall >= SCORE_THRESHOLDS.strong);
    const averageRooms = results.filter(r => r.scores.overall >= SCORE_THRESHOLDS.weak && r.scores.overall < SCORE_THRESHOLDS.strong);
    
    // Calculate aggregates
    const avgOverall = results.length > 0 ? results.reduce((sum, r) => sum + r.scores.overall, 0) / results.length : 0;
    const avgEconomic = results.length > 0 ? results.reduce((sum, r) => sum + r.scores.economic, 0) / results.length : 0;
    const avgMilitary = results.length > 0 ? results.reduce((sum, r) => sum + r.scores.military, 0) / results.length : 0;
    const avgDualPurpose = results.length > 0 ? results.reduce((sum, r) => sum + r.scores.dualPurpose, 0) / results.length : 0;
    
    // Total resources
    const totalStorageEnergy = results.reduce((sum, r) => sum + r.resources.storageEnergy, 0);
    const totalTerminalEnergy = results.reduce((sum, r) => sum + r.resources.terminalEnergy, 0);
    const totalPower = results.reduce((sum, r) => sum + r.resources.power, 0);
    const totalCombatBoosts = results.reduce((sum, r) => sum + r.resources.combatBoosts, 0);
    
    // Structure counts
    const totalSpawns = results.reduce((sum, r) => sum + r.structures.spawns, 0);
    const totalTowers = results.reduce((sum, r) => sum + r.structures.towers, 0);
    const totalLabs = results.reduce((sum, r) => sum + r.structures.labs, 0);
    const roomsWithNuker = results.filter(r => r.structures.nuker).length;
    const roomsWithFactory = results.filter(r => r.structures.factory).length;
    const roomsWithPowerSpawn = results.filter(r => r.structures.powerSpawn).length;
    
    // Print report
    printPlayerReport({
        playerName,
        elapsed,
        results,
        weakRooms,
        strongRooms,
        averageRooms,
        avgOverall,
        avgEconomic,
        avgMilitary,
        avgDualPurpose,
        totalStorageEnergy,
        totalTerminalEnergy,
        totalPower,
        totalCombatBoosts,
        totalSpawns,
        totalTowers,
        totalLabs,
        roomsWithNuker,
        roomsWithFactory,
        roomsWithPowerSpawn,
        enemyNukeThreats,
        myNukeTargets,
        myNukers
    });
    
    // Send notification
    let notifyMsg = `[PlayerAnalysis] ${playerName} analysis complete.\n`;
    notifyMsg += `Rooms: ${results.length} (${strongRooms.length} strong, ${averageRooms.length} average, ${weakRooms.length} weak)\n`;
    notifyMsg += `Avg Score: ${avgOverall.toFixed(1)}/100\n`;
    if (enemyNukeThreats.length > 0) {
        notifyMsg += `⚠️ NUKE THREATS: ${enemyNukeThreats.length} enemy nuker(s) can hit your rooms!`;
    }
    Game.notify(notifyMsg, 0);
    
    // Clean up
    delete Memory.playerAnalysis;
}

/**
 * Print the final report
 */
function printPlayerReport(data) {
    const div = '════════════════════════════════════════════════════════════════════════════════════════════════════';
    const lines = [];
    
    lines.push(div);
    lines.push('PLAYER ANALYSIS: ' + data.playerName + ' | Rooms: ' + data.results.length + ' | Analysis Time: ' + data.elapsed + ' ticks');
    lines.push(div);
    
    // === SCORE SUMMARY ===
    lines.push('');
    lines.push('📊 AVERAGE SCORES:');
    lines.push('   Overall: ' + data.avgOverall.toFixed(1) + '/100 | Economic: ' + data.avgEconomic.toFixed(1) + '/100 | Military: ' + data.avgMilitary.toFixed(1) + '/100 | Infrastructure: ' + data.avgDualPurpose.toFixed(1) + '/100');
    
    // === ROOM CLASSIFICATIONS ===
    lines.push('');
    lines.push('🏠 ROOM CLASSIFICATIONS:');
    
    if (data.strongRooms.length > 0) {
        const strongList = data.strongRooms.map(r => r.room + '(' + r.scores.overall.toFixed(0) + ')').join(', ');
        lines.push('   🟢 STRONG (' + data.strongRooms.length + '): ' + strongList);
    }
    
    if (data.averageRooms.length > 0) {
        const avgList = data.averageRooms.map(r => r.room + '(' + r.scores.overall.toFixed(0) + ')').join(', ');
        lines.push('   🟡 AVERAGE (' + data.averageRooms.length + '): ' + avgList);
    }
    
    if (data.weakRooms.length > 0) {
        const weakList = data.weakRooms.map(r => r.room + '(' + r.scores.overall.toFixed(0) + ')').join(', ');
        lines.push('   🔴 WEAK (' + data.weakRooms.length + '): ' + weakList);
    }
    
    // === INFRASTRUCTURE TOTALS ===
    lines.push('');
    lines.push('🏗️ INFRASTRUCTURE TOTALS:');
    lines.push('   Spawns: ' + data.totalSpawns + ' | Towers: ' + data.totalTowers + ' | Labs: ' + data.totalLabs);
    lines.push('   Nukers: ' + data.roomsWithNuker + ' | Factories: ' + data.roomsWithFactory + ' | Power Spawns: ' + data.roomsWithPowerSpawn);
    
    // === RESOURCE TOTALS ===
    lines.push('');
    lines.push('💰 RESOURCE TOTALS:');
    lines.push('   Storage Energy: ' + formatNumber(data.totalStorageEnergy) + ' | Terminal Energy: ' + formatNumber(data.totalTerminalEnergy));
    lines.push('   Power: ' + formatNumber(data.totalPower) + ' | Combat Boosts: ' + formatNumber(data.totalCombatBoosts));
    
    // === NUCLEAR THREAT ANALYSIS ===
    lines.push('');
    lines.push('☢️ NUCLEAR ANALYSIS:');
    
    if (data.enemyNukeThreats.length > 0) {
        lines.push('   ⚠️ ENEMY NUKE THREATS:');
        for (const threat of data.enemyNukeThreats) {
            const status = threat.ready ? '🔴 READY' : (threat.charging ? '🟡 CHARGING' : '⚪ EMPTY');
            lines.push('      ' + threat.enemyRoom + ' [' + status + '] threatens: ' + threat.threatens.join(', '));
        }
    } else {
        lines.push('   ✓ No enemy nukers can reach your rooms');
    }
    
    lines.push('');
    if (data.myNukeTargets.length > 0) {
        lines.push('   🎯 YOUR STRIKE CAPABILITY:');
        for (const target of data.myNukeTargets) {
            const status = target.ready ? '🟢 READY' : '⚪ NOT READY';
            lines.push('      ' + target.myRoom + ' [' + status + '] can hit: ' + target.canHit.join(', '));
        }
    } else {
        lines.push('   ✗ None of your nukers can reach ' + data.playerName + '\'s rooms');
    }
    
    // === PER-ROOM DETAILS ===
    lines.push('');
    lines.push('📋 PER-ROOM DETAILS:');
    lines.push('   Room         | RCL | Overall | Eco  | Mil  | Infra | Towers | Nuker    | Storage E  | Def Avg');
    lines.push('   ' + '-'.repeat(95));
    
    // Sort by overall score descending
    const sortedResults = data.results.slice().sort((a, b) => b.scores.overall - a.scores.overall);
    
    for (const r of sortedResults) {
        const roomPad = r.room.padEnd(12);
        const rclPad = String(r.rcl).padStart(3);
        const overallPad = r.scores.overall.toFixed(1).padStart(7);
        const ecoPad = r.scores.economic.toFixed(1).padStart(5);
        const milPad = r.scores.military.toFixed(1).padStart(5);
        const dualPad = r.scores.dualPurpose.toFixed(1).padStart(5);
        const towerPad = (r.structures.towers + '/6').padStart(6);
        let nukerStatus = 'None';
        if (r.structures.nuker) {
            nukerStatus = r.structures.nukerReady ? 'READY' : (r.structures.nukerCharging ? 'Charging' : 'Empty');
        }
        const nukerPad = nukerStatus.padStart(8);
        const storagePad = formatNumber(r.resources.storageEnergy).padStart(10);
        const defPad = formatNumber(r.defense.avgDefenseHits).padStart(9);
        
        lines.push('   ' + roomPad + ' | ' + rclPad + ' | ' + overallPad + ' | ' + ecoPad + ' | ' + milPad + ' | ' + dualPad + ' | ' + towerPad + ' | ' + nukerPad + ' | ' + storagePad + ' | ' + defPad);
    }
    
    // === VULNERABILITY ANALYSIS ===
    lines.push('');
    lines.push('🎯 ATTACK RECOMMENDATIONS:');
    
    // Find most vulnerable rooms
    const vulnerableTargets = sortedResults
        .filter(r => r.scores.military < 50)
        .sort((a, b) => a.scores.military - b.scores.military)
        .slice(0, 5);
    
    if (vulnerableTargets.length > 0) {
        lines.push('   Most vulnerable targets (low military score):');
        for (const r of vulnerableTargets) {
            const issues = [];
            if (r.structures.towers < 3) issues.push('few towers');
            if (r.defense.avgDefenseHits < 1000000) issues.push('weak walls');
            if (r.defense.weakRamparts > 0) issues.push('weak ramparts');
            if (r.resources.storageEnergy < 100000) issues.push('low energy');
            
            lines.push('      ' + r.room + ' (Mil: ' + r.scores.military.toFixed(1) + ') - ' + (issues.length > 0 ? issues.join(', ') : 'general weakness'));
        }
    } else {
        lines.push('   No obviously vulnerable rooms found.');
    }
    
    // Find nuke-ready targets
    const nukeableWeak = data.myNukeTargets
        .filter(t => t.ready)
        .map(t => ({
            myRoom: t.myRoom,
            targets: t.canHit.filter(target => {
                const intel = sortedResults.find(r => r.room === target);
                return intel && intel.scores.military < 50;
            })
        }))
        .filter(t => t.targets.length > 0);
    
    if (nukeableWeak.length > 0) {
        lines.push('');
        lines.push('   💥 NUKE-READY weak targets:');
        for (const n of nukeableWeak) {
            lines.push('      From ' + n.myRoom + ': ' + n.targets.join(', '));
        }
    }
    
    lines.push('');
    lines.push(div);
    lines.push('Analysis stored in Memory.lastPlayerAnalysis (expires in 10,000 ticks)');
    lines.push(div);
    
    // Store for reference (expires after 10k ticks)
    Memory.lastPlayerAnalysis = {
        player: data.playerName,
        tick: Game.time,
        expiresTick: Game.time + 10000,
        roomCount: data.results.length,
        
        // Score averages
        avgOverall: data.avgOverall,
        avgEconomic: data.avgEconomic,
        avgMilitary: data.avgMilitary,
        avgDualPurpose: data.avgDualPurpose,
        
        // Room classifications
        weakRooms: data.weakRooms.map(r => r.room),
        averageRooms: data.averageRooms.map(r => r.room),
        strongRooms: data.strongRooms.map(r => r.room),
        
        // Infrastructure totals
        totalSpawns: data.totalSpawns,
        totalTowers: data.totalTowers,
        totalLabs: data.totalLabs,
        roomsWithNuker: data.roomsWithNuker,
        roomsWithFactory: data.roomsWithFactory,
        roomsWithPowerSpawn: data.roomsWithPowerSpawn,
        
        // Resource totals
        totalStorageEnergy: data.totalStorageEnergy,
        totalTerminalEnergy: data.totalTerminalEnergy,
        totalPower: data.totalPower,
        totalCombatBoosts: data.totalCombatBoosts,
        
        // Per-room details (sorted by score)
        rooms: sortedResults.map(r => ({
            room: r.room,
            rcl: r.rcl,
            scores: r.scores,
            towers: r.structures.towers,
            nuker: r.structures.nuker,
            nukerReady: r.structures.nukerReady,
            nukerCharging: r.structures.nukerCharging,
            storageEnergy: r.resources.storageEnergy,
            avgDefenseHits: r.defense.avgDefenseHits,
            weakRamparts: r.defense.weakRamparts
        })),
        
        // Nuclear analysis
        nukeThreats: data.enemyNukeThreats,
        myStrikes: data.myNukeTargets
    };
    
    // Print as single log
    console.log(lines.join('\n'));
}

/**
 * Format number helper
 */
function formatNumber(num) {
    if (num === undefined || num === null) return '0';
    if (num >= 1000000000) return (num / 1000000000).toFixed(1) + 'B';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
    return String(num);
}

/**
 * Quick lookup of last analysis - prints full report
 */
function getLastAnalysis() {
    if (!Memory.lastPlayerAnalysis) {
        console.log('[PlayerAnalysis] No previous analysis found.');
        return null;
    }
    
    const data = Memory.lastPlayerAnalysis;
    
    // Check if expired
    if (data.expiresTick <= Game.time) {
        console.log('[PlayerAnalysis] Previous analysis has expired. Clearing...');
        delete Memory.lastPlayerAnalysis;
        return null;
    }
    
    // Reprint the full report
    reprintReport(data);
    
    return data;
}

/**
 * Reprint report from stored data
 */
function reprintReport(data) {
    const div = '════════════════════════════════════════════════════════════════════════════════════════════════════';
    const lines = [];
    
    const ticksAgo = Game.time - data.tick;
    const ticksRemaining = data.expiresTick - Game.time;
    
    lines.push(div);
    lines.push('PLAYER ANALYSIS: ' + data.player + ' | Rooms: ' + data.roomCount + ' | Analyzed ' + ticksAgo + ' ticks ago (expires in ' + ticksRemaining + ')');
    lines.push(div);
    
    // Handle backward compatibility with old data format
    const avgOverall = data.avgOverall !== undefined ? data.avgOverall : (data.avgScore || 0);
    const avgEconomic = data.avgEconomic !== undefined ? data.avgEconomic : 0;
    const avgMilitary = data.avgMilitary !== undefined ? data.avgMilitary : 0;
    const avgDualPurpose = data.avgDualPurpose !== undefined ? data.avgDualPurpose : 0;
    
    // === SCORE SUMMARY ===
    lines.push('');
    lines.push('📊 AVERAGE SCORES:');
    if (avgEconomic === 0 && avgMilitary === 0 && avgDualPurpose === 0) {
        // Old format - only have overall
        lines.push('   Overall: ' + avgOverall.toFixed(1) + '/100 (detailed scores not available - run analysis again for full data)');
    } else {
        lines.push('   Overall: ' + avgOverall.toFixed(1) + '/100 | Economic: ' + avgEconomic.toFixed(1) + '/100 | Military: ' + avgMilitary.toFixed(1) + '/100 | Infrastructure: ' + avgDualPurpose.toFixed(1) + '/100');
    }
    
    // === ROOM CLASSIFICATIONS ===
    lines.push('');
    lines.push('🏠 ROOM CLASSIFICATIONS:');
    
    const strongRooms = data.strongRooms || [];
    const averageRooms = data.averageRooms || [];
    const weakRooms = data.weakRooms || [];
    
    if (strongRooms.length > 0) {
        const strongList = strongRooms.map(r => {
            const roomData = data.rooms.find(rd => rd.room === r);
            return r + '(' + (roomData && roomData.scores ? roomData.scores.overall.toFixed(0) : '?') + ')';
        }).join(', ');
        lines.push('   🟢 STRONG (' + strongRooms.length + '): ' + strongList);
    }
    
    if (averageRooms.length > 0) {
        const avgList = averageRooms.map(r => {
            const roomData = data.rooms.find(rd => rd.room === r);
            return r + '(' + (roomData && roomData.scores ? roomData.scores.overall.toFixed(0) : '?') + ')';
        }).join(', ');
        lines.push('   🟡 AVERAGE (' + averageRooms.length + '): ' + avgList);
    }
    
    if (weakRooms.length > 0) {
        const weakList = weakRooms.map(r => {
            const roomData = data.rooms.find(rd => rd.room === r);
            return r + '(' + (roomData && roomData.scores ? roomData.scores.overall.toFixed(0) : '?') + ')';
        }).join(', ');
        lines.push('   🔴 WEAK (' + weakRooms.length + '): ' + weakList);
    }
    
    // If no classifications, just list rooms
    if (strongRooms.length === 0 && averageRooms.length === 0 && weakRooms.length === 0 && data.rooms) {
        lines.push('   Rooms: ' + data.rooms.map(r => r.room).join(', '));
    }
    
    // === INFRASTRUCTURE TOTALS ===
    if (data.totalSpawns !== undefined) {
        lines.push('');
        lines.push('🏗️ INFRASTRUCTURE TOTALS:');
        lines.push('   Spawns: ' + (data.totalSpawns || 0) + ' | Towers: ' + (data.totalTowers || 0) + ' | Labs: ' + (data.totalLabs || 0));
        lines.push('   Nukers: ' + (data.roomsWithNuker || 0) + ' | Factories: ' + (data.roomsWithFactory || 0) + ' | Power Spawns: ' + (data.roomsWithPowerSpawn || 0));
    }
    
    // === RESOURCE TOTALS ===
    if (data.totalStorageEnergy !== undefined) {
        lines.push('');
        lines.push('💰 RESOURCE TOTALS:');
        lines.push('   Storage Energy: ' + formatNumber(data.totalStorageEnergy) + ' | Terminal Energy: ' + formatNumber(data.totalTerminalEnergy));
        lines.push('   Power: ' + formatNumber(data.totalPower) + ' | Combat Boosts: ' + formatNumber(data.totalCombatBoosts));
    }
    
    // === NUCLEAR THREAT ANALYSIS ===
    lines.push('');
    lines.push('☢️ NUCLEAR ANALYSIS:');
    
    if (data.nukeThreats && data.nukeThreats.length > 0) {
        lines.push('   ⚠️ ENEMY NUKE THREATS:');
        for (const threat of data.nukeThreats) {
            const status = threat.ready ? '🔴 READY' : (threat.charging ? '🟡 CHARGING' : '⚪ EMPTY');
            lines.push('      ' + threat.enemyRoom + ' [' + status + '] threatens: ' + threat.threatens.join(', '));
        }
    } else {
        lines.push('   ✓ No enemy nukers can reach your rooms');
    }
    
    lines.push('');
    if (data.myStrikes && data.myStrikes.length > 0) {
        lines.push('   🎯 YOUR STRIKE CAPABILITY:');
        for (const target of data.myStrikes) {
            const status = target.ready ? '🟢 READY' : '⚪ NOT READY';
            lines.push('      ' + target.myRoom + ' [' + status + '] can hit: ' + target.canHit.join(', '));
        }
    } else {
        lines.push('   ✗ None of your nukers can reach ' + data.player + '\'s rooms');
    }
    
    // === PER-ROOM DETAILS ===
    if (data.rooms && data.rooms.length > 0 && data.rooms[0].scores) {
        lines.push('');
        lines.push('📋 PER-ROOM DETAILS:');
        lines.push('   Room         | RCL | Overall | Eco  | Mil  | Infra | Towers | Nuker    | Storage E  | Def Avg');
        lines.push('   ' + '-'.repeat(95));
        
        for (const r of data.rooms) {
            const roomPad = r.room.padEnd(12);
            const rclPad = String(r.rcl).padStart(3);
            const overallPad = (r.scores ? r.scores.overall.toFixed(1) : '?').toString().padStart(7);
            const ecoPad = (r.scores ? r.scores.economic.toFixed(1) : '?').toString().padStart(5);
            const milPad = (r.scores ? r.scores.military.toFixed(1) : '?').toString().padStart(5);
            const dualPad = (r.scores ? r.scores.dualPurpose.toFixed(1) : '?').toString().padStart(5);
            const towerPad = ((r.towers !== undefined ? r.towers : '?') + '/6').padStart(6);
            let nukerStatus = 'None';
            if (r.nuker) {
                nukerStatus = r.nukerReady ? 'READY' : (r.nukerCharging ? 'Charging' : 'Empty');
            }
            const nukerPad = nukerStatus.padStart(8);
            const storagePad = formatNumber(r.storageEnergy !== undefined ? r.storageEnergy : 0).padStart(10);
            const defPad = formatNumber(r.avgDefenseHits !== undefined ? r.avgDefenseHits : 0).padStart(9);
            
            lines.push('   ' + roomPad + ' | ' + rclPad + ' | ' + overallPad + ' | ' + ecoPad + ' | ' + milPad + ' | ' + dualPad + ' | ' + towerPad + ' | ' + nukerPad + ' | ' + storagePad + ' | ' + defPad);
        }
        
        // === VULNERABILITY ANALYSIS ===
        lines.push('');
        lines.push('🎯 ATTACK RECOMMENDATIONS:');
        
        // Find most vulnerable rooms
        const vulnerableTargets = data.rooms
            .filter(r => r.scores && r.scores.military < 50)
            .sort((a, b) => a.scores.military - b.scores.military)
            .slice(0, 5);
        
        if (vulnerableTargets.length > 0) {
            lines.push('   Most vulnerable targets (low military score):');
            for (const r of vulnerableTargets) {
                const issues = [];
                if (r.towers !== undefined && r.towers < 3) issues.push('few towers');
                if (r.avgDefenseHits !== undefined && r.avgDefenseHits < 1000000) issues.push('weak walls');
                if (r.weakRamparts !== undefined && r.weakRamparts > 0) issues.push('weak ramparts');
                if (r.storageEnergy !== undefined && r.storageEnergy < 100000) issues.push('low energy');
                
                lines.push('      ' + r.room + ' (Mil: ' + r.scores.military.toFixed(1) + ') - ' + (issues.length > 0 ? issues.join(', ') : 'general weakness'));
            }
        } else {
            lines.push('   No obviously vulnerable rooms found.');
        }
        
        // Find nuke-ready targets
        if (data.myStrikes) {
            const nukeableWeak = data.myStrikes
                .filter(t => t.ready)
                .map(t => ({
                    myRoom: t.myRoom,
                    targets: t.canHit.filter(target => {
                        const roomData = data.rooms.find(r => r.room === target);
                        return roomData && roomData.scores && roomData.scores.military < 50;
                    })
                }))
                .filter(t => t.targets.length > 0);
            
            if (nukeableWeak.length > 0) {
                lines.push('');
                lines.push('   💥 NUKE-READY weak targets:');
                for (const n of nukeableWeak) {
                    lines.push('      From ' + n.myRoom + ': ' + n.targets.join(', '));
                }
            }
        }
    } else {
        // Old format - just list rooms
        lines.push('');
        lines.push('📋 ROOMS (limited data - run analysis again for full details):');
        if (data.rooms) {
            for (const r of data.rooms) {
                lines.push('   ' + r.room + ' (RCL ' + r.rcl + ')');
            }
        }
    }
    
    lines.push('');
    lines.push(div);
    
    // Print as single log
    console.log(lines.join('\n'));
}

// Module exports
module.exports = {
    start: startPlayerAnalysis,
    run: run,
    cancel: cancelPlayerAnalysis,
    status: getAnalysisStatus,
    last: getLastAnalysis
};

// Global console commands
global.player = startPlayerAnalysis;
global.playerCancel = cancelPlayerAnalysis;
global.playerStatus = getAnalysisStatus;
global.playerLast = getLastAnalysis;