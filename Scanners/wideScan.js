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
 *   wideScanStatus()        - Check progress of active scan
 *                             Shows rooms scanned, rooms found, ETA
 * 
 *   wideScanCancel()        - Cancel active scan
 *                             Stops scanning immediately
 * 
 * ═══════════════════════════════════════════════════════════════════
 * 
 * This module will:
 * 1. Find all observers in your owned rooms
 * 2. Calculate all rooms within range (10) of each observer
 * 3. Deduplicate the room list
 * 4. Scan one room per tick using observers
 * 5. Track which rooms are owned by the target player
 * 6. Report results via console and Game.notify when complete
 * 
 * INTEGRATION:
 *   const wideScan = require('wideScan');
 *   profiler.registerObject(wideScan, 'wideScan');
 *   // In main loop (MUST run every tick, no modulo):
 *   profileSection('wideScan.run', function(){ wideScan.run(); });
 * 
 * NOTE: The player() command from playerAnalysis.js does everything
 * wideScan does plus runs detailed intel, so you typically only need
 * to use player() unless you just want a quick room list.
 */

const OBSERVER_RANGE = 10;

/**
 * Parse a room name into sector and coordinates
 * @param {string} roomName 
 * @returns {{wx: number, wy: number}} World coordinates
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
 * @param {number} wx 
 * @param {number} wy 
 * @returns {string} Room name
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
 * Get all rooms within observer range of a given room
 * @param {string} observerRoom 
 * @returns {string[]} Array of room names in range
 */
function getRoomsInRange(observerRoom) {
    const center = parseRoomName(observerRoom);
    if (!center) return [];
    
    const rooms = [];
    
    for (let dx = -OBSERVER_RANGE; dx <= OBSERVER_RANGE; dx++) {
        for (let dy = -OBSERVER_RANGE; dy <= OBSERVER_RANGE; dy++) {
            // Skip the center room (we own it)
            if (dx === 0 && dy === 0) continue;
            
            const roomName = toRoomName(center.wx + dx, center.wy + dy);
            rooms.push(roomName);
        }
    }
    
    return rooms;
}

/**
 * Check if a room name is valid (not a highway intersection or out of bounds)
 * @param {string} roomName 
 * @returns {boolean}
 */
function isValidRoom(roomName) {
    const parsed = parseRoomName(roomName);
    if (!parsed) return false;
    
    // Room coordinates should be reasonable (not negative room numbers after conversion)
    const match = roomName.match(/^([WE])(\d+)([NS])(\d+)$/);
    if (!match) return false;
    
    return true;
}

/**
 * Find the best observer to scan a target room
 * @param {string} targetRoom 
 * @param {Object} observerMap - Map of roomName -> observer object
 * @returns {StructureObserver|null}
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
 * Initialize a wide scan for a specific player
 * @param {string} playerName - The player to search for
 */
function startWideScan(playerName) {
    if (!playerName || typeof playerName !== 'string') {
        console.log('[WideScan] Error: Please provide a player name. Usage: wideScan("PlayerName")');
        return;
    }
    
    // Find all observers
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
        return;
    }
    
    console.log(`[WideScan] Found ${observerRooms.length} observer(s) in rooms: ${observerRooms.join(', ')}`);
    
    // Calculate all rooms in range of all observers
    const roomSet = new Set();
    
    for (const observerRoom of observerRooms) {
        const roomsInRange = getRoomsInRange(observerRoom);
        for (const room of roomsInRange) {
            if (isValidRoom(room)) {
                roomSet.add(room);
            }
        }
    }
    
    // Convert to array and remove our own rooms
    const roomsToScan = Array.from(roomSet).filter(roomName => {
        const room = Game.rooms[roomName];
        return !room || !room.controller || !room.controller.my;
    });
    
    console.log(`[WideScan] Total unique rooms to scan: ${roomsToScan.length}`);
    const scanMinutes = Math.ceil((roomsToScan.length * 3) / 60);
    console.log(`[WideScan] Estimated completion time: ${roomsToScan.length} ticks (~${scanMinutes} minutes)`);
    
    // Store scan state in Memory
    Memory.wideScan = {
        active: true,
        targetPlayer: playerName,
        roomsToScan: roomsToScan,
        scannedCount: 0,
        totalRooms: roomsToScan.length,
        foundRooms: [],
        startTick: Game.time,
        observerRooms: observerRooms
    };
    
    console.log(`[WideScan] Scan started for player: ${playerName}`);
}

/**
 * Cancel an active wide scan
 */
function cancelWideScan() {
    if (Memory.wideScan && Memory.wideScan.active) {
        console.log('[WideScan] Scan cancelled.');
        delete Memory.wideScan;
    } else {
        console.log('[WideScan] No active scan to cancel.');
    }
}

/**
 * Get the current status of a wide scan
 */
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
    console.log(`  Target Player: ${scan.targetPlayer}`);
    console.log(`  Progress: ${scan.scannedCount}/${scan.totalRooms} (${progress}%)`);
    console.log(`  Elapsed: ${elapsed} ticks`);
    console.log(`  Remaining: ~${remaining} ticks`);
    console.log(`  Rooms found so far: ${scan.foundRooms.length > 0 ? scan.foundRooms.join(', ') : 'None'}`);
    
    return scan;
}

/**
 * Run function - call this every tick from main loop
 */
function run() {
    if (!Memory.wideScan || !Memory.wideScan.active) return;
    
    const scan = Memory.wideScan;
    
    // Check if we have rooms left to scan
    if (scan.roomsToScan.length === 0) {
        // Scan complete
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
        
        if (observer) {
            observerMap[roomName] = observer;
        }
    }
    
    // Process the room that was observed last tick (if any)
    if (scan.lastObservedRoom) {
        const room = Game.rooms[scan.lastObservedRoom];
        if (room) {
            // Check if this room is owned by the target player
            if (room.controller && room.controller.owner && 
                room.controller.owner.username === scan.targetPlayer) {
                
                if (!scan.foundRooms.includes(scan.lastObservedRoom)) {
                    scan.foundRooms.push(scan.lastObservedRoom);
                    console.log(`[WideScan] Found ${scan.targetPlayer}'s room: ${scan.lastObservedRoom} (RCL ${room.controller.level})`);
                }
            }
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
    
    // Find an observer that can reach this room
    const observer = findObserverForRoom(nextRoom, observerMap);
    
    if (observer) {
        const result = observer.observeRoom(nextRoom);
        if (result === OK) {
            scan.lastObservedRoom = nextRoom;
        } else {
            // Failed to observe, skip this room
            console.log(`[WideScan] Failed to observe ${nextRoom}: ${result}`);
            scan.scannedCount++;
        }
    } else {
        // No observer in range (shouldn't happen, but handle it)
        scan.scannedCount++;
    }
    
    // Progress update every 100 rooms
    if (scan.scannedCount > 0 && scan.scannedCount % 100 === 0) {
        const progress = ((scan.scannedCount / scan.totalRooms) * 100).toFixed(1);
        console.log(`[WideScan] Progress: ${scan.scannedCount}/${scan.totalRooms} (${progress}%) - Found ${scan.foundRooms.length} room(s)`);
    }
}

/**
 * Complete the scan and report results
 */
function completeScan() {
    const scan = Memory.wideScan;
    if (!scan) return;
    
    const elapsed = Game.time - scan.startTick;
    const foundRooms = scan.foundRooms;
    const targetPlayer = scan.targetPlayer;
    
    // Build result message
    let message;
    if (foundRooms.length > 0) {
        message = `${targetPlayer} owns: ${foundRooms.sort().join(', ')}`;
    } else {
        message = `${targetPlayer} owns no rooms within observer range.`;
    }
    
    // Console output
    console.log('================================================================');
    console.log('[WideScan] SCAN COMPLETE');
    console.log(`  Target: ${targetPlayer}`);
    console.log(`  Rooms scanned: ${scan.totalRooms}`);
    console.log(`  Time elapsed: ${elapsed} ticks`);
    console.log(`  Rooms found: ${foundRooms.length}`);
    console.log('');
    console.log(`  ${message}`);
    console.log('================================================================');
    
    // Game.notify
    Game.notify(`[WideScan Complete] ${message}`, 0);
    
    // Clean up
    delete Memory.wideScan;
}

// Export for console access
module.exports = {
    start: startWideScan,
    run: run,
    cancel: cancelWideScan,
    status: getWideScanStatus
};

// Global function for easy console access
global.wideScan = startWideScan;
global.wideScanCancel = cancelWideScan;
global.wideScanStatus = getWideScanStatus;