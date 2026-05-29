/**
 * wideScan.js - Scan all rooms in observer range for a specific player's owned rooms
 * 
 * ═══════════════════════════════════════════════════════════════════
 * CONSOLE COMMANDS:
 * ═══════════════════════════════════════════════════════════════════
 * 
 *   wideScan('PlayerName')  - Start scanning for a player's rooms
 *                             Uses all observers to scan every room
 *                             in range, reports which are owned by
 *                             the target player
 * 
 *   wideScanPlayers()       - Scan all rooms in observer range and
 *                             return a list of every player found,
 *                             with their room names and RCL levels
 * 
 *   wideScanStatus()        - Check progress of active scan
 *                             Shows rooms scanned, rooms found, ETA
 * 
 *   wideScanCancel()        - Cancel active scan
 *                             Stops scanning immediately
 * 
 * ═══════════════════════════════════════════════════════════════════
 */

const OBSERVER_RANGE = 10;

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

function getRoomsInRange(observerRoom) {
    const center = parseRoomName(observerRoom);
    if (!center) return [];
    
    const rooms = [];
    
    for (let dx = -OBSERVER_RANGE; dx <= OBSERVER_RANGE; dx++) {
        for (let dy = -OBSERVER_RANGE; dy <= OBSERVER_RANGE; dy++) {
            if (dx === 0 && dy === 0) continue;
            rooms.push(toRoomName(center.wx + dx, center.wy + dy));
        }
    }
    
    return rooms;
}

function isValidRoom(roomName) {
    return !!parseRoomName(roomName);
}

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
 * Shared bootstrap used by both startWideScan and startWideScanPlayers.
 * Returns false (with an error log) if no observers are available.
 * @param {string|null} playerName - null means "scan for all players"
 */
function initScan(playerName) {
    const observerMap = {};
    const observerRooms = [];
    
    for (const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if (!room.controller || !room.controller.my) continue;
        
        const observer = room.find(FIND_MY_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_OBSERVER
        })[0];
        
        if (observer) {
            observerMap[roomName] = observer;
            observerRooms.push(roomName);
        }
    }
    
    if (observerRooms.length === 0) {
        console.log('[WideScan] Error: No observers found in any owned rooms.');
        return false;
    }
    
    console.log(`[WideScan] Found ${observerRooms.length} observer(s) in rooms: ${observerRooms.join(', ')}`);
    
    const roomSet = new Set();
    for (const observerRoom of observerRooms) {
        for (const room of getRoomsInRange(observerRoom)) {
            if (isValidRoom(room)) roomSet.add(room);
        }
    }
    
    const roomsToScan = Array.from(roomSet).filter(roomName => {
        const room = Game.rooms[roomName];
        return !room || !room.controller || !room.controller.my;
    });
    
    console.log(`[WideScan] Total unique rooms to scan: ${roomsToScan.length}`);
    const scanMinutes = Math.ceil(roomsToScan.length / 60);
    console.log(`[WideScan] Estimated completion time: ${roomsToScan.length} ticks (~${scanMinutes} minutes)`);
    
    Memory.wideScan = {
        active: true,
        // null targetPlayer means "collect all players"
        targetPlayer: playerName || null,
        roomsToScan: roomsToScan,
        scannedCount: 0,
        totalRooms: roomsToScan.length,
        // Single-player mode: array of room name strings
        // All-players mode:   object keyed by player name -> array of { room, rcl }
        foundRooms: playerName ? [] : {},
        startTick: Game.time,
        observerRooms: observerRooms
    };
    
    const label = playerName ? `player: ${playerName}` : 'all players in range';
    console.log(`[WideScan] Scan started for ${label}`);
    
    return true;
}

/**
 * Start a targeted scan for one player's rooms.
 * @param {string} playerName
 */
function startWideScan(playerName) {
    if (!playerName || typeof playerName !== 'string') {
        console.log('[WideScan] Error: Please provide a player name. Usage: wideScan("PlayerName")');
        return;
    }
    initScan(playerName);
}

/**
 * Start a scan that collects every player visible in observer range.
 */
function startWideScanPlayers() {
    initScan(null);
}

function cancelWideScan() {
    if (Memory.wideScan && Memory.wideScan.active) {
        console.log('[WideScan] Scan cancelled.');
        delete Memory.wideScan;
    } else {
        console.log('[WideScan] No active scan to cancel.');
    }
}

function getWideScanStatus() {
    if (!Memory.wideScan || !Memory.wideScan.active) {
        console.log('[WideScan] No active scan.');
        return null;
    }
    
    const scan = Memory.wideScan;
    const progress = ((scan.scannedCount / scan.totalRooms) * 100).toFixed(1);
    const elapsed = Game.time - scan.startTick;
    const remaining = scan.totalRooms - scan.scannedCount;
    
    console.log(`[WideScan] Status:`);
    console.log(`  Mode: ${scan.targetPlayer ? `target player "${scan.targetPlayer}"` : 'all players'}`);
    console.log(`  Progress: ${scan.scannedCount}/${scan.totalRooms} (${progress}%)`);
    console.log(`  Elapsed: ${elapsed} ticks`);
    console.log(`  Remaining: ~${remaining} ticks`);
    
    if (scan.targetPlayer) {
        // Single-player mode
        console.log(`  Rooms found so far: ${scan.foundRooms.length > 0 ? scan.foundRooms.join(', ') : 'None'}`);
    } else {
        // All-players mode
        const playerCount = Object.keys(scan.foundRooms).length;
        if (playerCount === 0) {
            console.log(`  Players found so far: None`);
        } else {
            console.log(`  Players found so far (${playerCount}):`);
            for (const player in scan.foundRooms) {
                const rooms = scan.foundRooms[player].map(r => `${r.room}(RCL${r.rcl})`).join(', ');
                console.log(`    ${player}: ${rooms}`);
            }
        }
    }
    
    return scan;
}

/**
 * Record a found room into foundRooms, handling both scan modes.
 * @param {Object} scan      - Memory.wideScan
 * @param {string} roomName  - The room that was observed
 * @param {Room}   room      - The Game.rooms object for that room
 */
function recordFound(scan, roomName, room) {
    const owner = room.controller.owner.username;
    const rcl   = room.controller.level;
    
    if (scan.targetPlayer) {
        // Single-player mode: simple dedup array
        if (owner === scan.targetPlayer && !scan.foundRooms.includes(roomName)) {
            scan.foundRooms.push(roomName);
            console.log(`[WideScan] Found ${owner}'s room: ${roomName} (RCL ${rcl})`);
        }
    } else {
        // All-players mode: group by player name
        if (!scan.foundRooms[owner]) {
            scan.foundRooms[owner] = [];
            console.log(`[WideScan] New player discovered: ${owner} (${roomName}, RCL ${rcl})`);
        }
        // Dedup by room name
        if (!scan.foundRooms[owner].some(r => r.room === roomName)) {
            scan.foundRooms[owner].push({ room: roomName, rcl });
        }
    }
}

function run() {
    if (!Memory.wideScan || !Memory.wideScan.active) return;
    
    const scan = Memory.wideScan;
    
    if (scan.roomsToScan.length === 0) {
        completeScan();
        return;
    }
    
    // Build observer map for this tick
    const observerMap = {};
    for (const roomName of scan.observerRooms) {
        const room = Game.rooms[roomName];
        if (!room) continue;
        
        const observer = room.find(FIND_MY_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_OBSERVER
        })[0];
        
        if (observer) observerMap[roomName] = observer;
    }
    
    // Process the room that was observed last tick
    if (scan.lastObservedRoom) {
        const room = Game.rooms[scan.lastObservedRoom];
        if (room && room.controller && room.controller.owner) {
            recordFound(scan, scan.lastObservedRoom, room);
        }
        scan.scannedCount++;
        delete scan.lastObservedRoom;
    }
    
    // Get next room to scan
    const nextRoom = scan.roomsToScan.shift();
    if (!nextRoom) {
        completeScan();
        return;
    }
    
    const observer = findObserverForRoom(nextRoom, observerMap);
    
    if (observer) {
        const result = observer.observeRoom(nextRoom);
        if (result === OK) {
            scan.lastObservedRoom = nextRoom;
        } else {
            console.log(`[WideScan] Failed to observe ${nextRoom}: ${result}`);
            scan.scannedCount++;
        }
    } else {
        scan.scannedCount++;
    }
    
    if (scan.scannedCount > 0 && scan.scannedCount % 100 === 0) {
        const progress = ((scan.scannedCount / scan.totalRooms) * 100).toFixed(1);
        
        if (scan.targetPlayer) {
            console.log(`[WideScan] Progress: ${scan.scannedCount}/${scan.totalRooms} (${progress}%) - Found ${scan.foundRooms.length} room(s)`);
        } else {
            const playerCount = Object.keys(scan.foundRooms).length;
            console.log(`[WideScan] Progress: ${scan.scannedCount}/${scan.totalRooms} (${progress}%) - Found ${playerCount} player(s)`);
        }
    }
}

function completeScan() {
    const scan = Memory.wideScan;
    if (!scan) return;
    
    const elapsed = Game.time - scan.startTick;
    
    console.log('================================================================');
    console.log('[WideScan] SCAN COMPLETE');
    console.log(`  Mode: ${scan.targetPlayer ? `target player "${scan.targetPlayer}"` : 'all players'}`);
    console.log(`  Rooms scanned: ${scan.totalRooms}`);
    console.log(`  Time elapsed: ${elapsed} ticks`);
    
    if (scan.targetPlayer) {
        // Single-player results (unchanged behaviour)
        const foundRooms = scan.foundRooms;
        console.log(`  Rooms found: ${foundRooms.length}`);
        console.log('');
        
        const message = foundRooms.length > 0
            ? `${scan.targetPlayer} owns: ${foundRooms.sort().join(', ')}`
            : `${scan.targetPlayer} owns no rooms within observer range.`;
        
        console.log(`  ${message}`);
        //Game.notify(`[WideScan Complete] ${message}`, 0);
    } else {
        // All-players results
        const players = Object.keys(scan.foundRooms).sort();
        console.log(`  Players found: ${players.length}`);
        console.log('');
        
        if (players.length === 0) {
            console.log('  No owned rooms found within observer range.');
        } else {
            for (const player of players) {
                const rooms = scan.foundRooms[player]
                    .sort((a, b) => a.room.localeCompare(b.room))
                    .map(r => `${r.room}(RCL${r.rcl})`)
                    .join(', ');
                console.log(`  ${player}: ${rooms}`);
            }
        }
    }
    
    console.log('================================================================');
    
    delete Memory.wideScan;
}

module.exports = {
    start: startWideScan,
    startPlayers: startWideScanPlayers,
    run: run,
    cancel: cancelWideScan,
    status: getWideScanStatus
};

global.wideScan        = startWideScan;
global.wideScanPlayers = startWideScanPlayers;
global.wideScanCancel  = cancelWideScan;
global.wideScanStatus  = getWideScanStatus;