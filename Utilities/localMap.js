/**
 * localMap.js - Scan all rooms in observer range and build a local intelligence map
 *
 * ═══════════════════════════════════════════════════════════════════
 * CONSOLE COMMANDS:
 * ═══════════════════════════════════════════════════════════════════
 *   localMap()         - Start a full scan of all rooms in observer range.
 *                        Collects owner, RCL, room type, sources, mineral,
 *                        towers, spawns, nuker, storage, terminal,
 *                        and average wall/rampart strength.
 *   localMapStatus()   - Check progress of active scan.
 *                        Shows rooms scanned, rooms found, ETA.
 *   localMapCancel()   - Cancel an active scan immediately.
 *   localMapReport()   - Re-print the results of the last completed scan.

 */

'use strict';

const OBSERVER_RANGE = 10;

// Game.notify has a hard ~1000-char limit per call.
// We chunk at 400 — if adding the next line would exceed this,
// it goes into the next notify call instead.
const NOTIFY_CHUNK_MAX = 400;

// ─── Room name utilities (identical to wideScan) ────────────────────────────

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
    let ew, ewNum, ns, nsNum;
    if (wx < 0) { ew = 'W'; ewNum = -wx - 1; } else { ew = 'E'; ewNum = wx; }
    if (wy < 0) { ns = 'N'; nsNum = -wy - 1; } else { ns = 'S'; nsNum = wy; }
    return `${ew}${ewNum}${ns}${nsNum}`;
}

function isValidRoom(roomName) {
    return !!parseRoomName(roomName);
}

// ─── Room type from coordinates ─────────────────────────────────────────────
//
//   Screeps sectors are 10×10 blocks of rooms.
//   - Highway/intersection: either displayed coordinate is divisible by 10
//   - Source Keeper:        both displayed coordinates mod-10 fall in [4, 5, 6]
//   - Normal:               everything else (claimed / unclaimed determined at scan time)

function getCoordRoomType(roomName) {
    const parsed = parseRoomName(roomName);
    if (!parsed) return null;

    // Recover the unsigned display numbers
    const ewNum = parsed.wx >= 0 ? parsed.wx : -parsed.wx - 1;
    const nsNum = parsed.wy >= 0 ? parsed.wy : -parsed.wy - 1;

    const ex = ewNum % 10;
    const ey = nsNum % 10;

    if (ex === 0 && ey === 0) return 'intersection';
    if (ex === 0 || ey === 0) return 'highway';
    if (ex >= 4 && ex <= 6 && ey >= 4 && ey <= 6) return 'sourceKeeper';

    return null; // normal room — claimed / unclaimed resolved from live data
}

// ─── Observer utilities ─────────────────────────────────────────────────────

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

function findObserverForRoom(targetRoom, observerMap) {
    const target = parseRoomName(targetRoom);
    if (!target) return null;
    for (const observerRoomName in observerMap) {
        const oc = parseRoomName(observerRoomName);
        if (!oc) continue;
        const dist = Math.max(
            Math.abs(target.wx - oc.wx),
            Math.abs(target.wy - oc.wy)
        );
        if (dist <= OBSERVER_RANGE) return observerMap[observerRoomName];
    }
    return null;
}

// ─── Data collection (called the tick after observeRoom) ────────────────────

function collectRoomData(roomName, room) {
    // Start with coordinate-based type; refine for normal rooms below
    const coordType = getCoordRoomType(roomName);

    const data = {
        room:           roomName,
        type:           coordType,   // filled in below if null
        scannedAt:      Game.time,
        owner:          null,
        rcl:            0,
        safeMode:       false,
        sources:        0,
        mineral:        null,
        towers:         0,
        spawns:         0,
        hasNuker:       false,
        hasStorage:     false,
        hasTerminal:    false,
        avgDefenseHits: 0,
    };

    // Controller info
    if (room.controller) {
        if (room.controller.owner) {
            data.owner  = room.controller.owner.username;
            data.rcl    = room.controller.level;
            data.type   = data.type || 'claimed';
        } else {
            data.type = data.type || 'unclaimed';
        }
        if (room.controller.safeMode) data.safeMode = true;
    } else {
        data.type = data.type || 'unclaimed';
    }

    // Sources & mineral
    data.sources = room.find(FIND_SOURCES).length;
    const minerals = room.find(FIND_MINERALS);
    if (minerals.length > 0) data.mineral = minerals[0].mineralType;

    // Structures — FIND_STRUCTURES gives us everything visible
    let defHitsTotal = 0;
    let defCount     = 0;

    const structures = room.find(FIND_STRUCTURES);
    for (const s of structures) {
        switch (s.structureType) {
            case STRUCTURE_TOWER:    data.towers++;           break;
            case STRUCTURE_SPAWN:    data.spawns++;           break;
            case STRUCTURE_NUKER:    data.hasNuker    = true; break;
            case STRUCTURE_STORAGE:  data.hasStorage  = true; break;
            case STRUCTURE_TERMINAL: data.hasTerminal = true; break;
            case STRUCTURE_WALL:
            case STRUCTURE_RAMPART:
                defHitsTotal += s.hits;
                defCount++;
                break;
        }
    }

    if (defCount > 0) data.avgDefenseHits = Math.round(defHitsTotal / defCount);

    return data;
}

// ─── Scan lifecycle ──────────────────────────────────────────────────────────

function startLocalMap() {
    const observerMap  = {};
    const observerRooms = [];

    for (const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if (!room.controller || !room.controller.my) continue;
        const observer = room.find(FIND_MY_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_OBSERVER
        })[0];
        if (observer) {
            observerMap[roomName]  = observer;
            observerRooms.push(roomName);
        }
    }

    if (observerRooms.length === 0) {
        console.log('[LocalMap] Error: No observers found in any owned rooms.');
        return;
    }

    console.log(`[LocalMap] Found ${observerRooms.length} observer(s): ${observerRooms.join(', ')}`);

    const roomSet = new Set();
    for (const observerRoom of observerRooms) {
        for (const r of getRoomsInRange(observerRoom)) {
            if (isValidRoom(r)) roomSet.add(r);
        }
    }

    const roomsToScan = Array.from(roomSet);
    const scanMinutes = Math.ceil(roomsToScan.length / 60);

    console.log(`[LocalMap] Rooms to scan: ${roomsToScan.length} (~${scanMinutes} min at 60 ticks/min)`);

    Memory.localMap = {
        active:           true,
        roomsToScan:      roomsToScan,
        scannedCount:     0,
        totalRooms:       roomsToScan.length,
        results:          {},
        startTick:        Game.time,
        observerRooms:    observerRooms,
        lastObservedRoom: null,
    };

    console.log('[LocalMap] Scan started.');
}

function run() {
    if (!Memory.localMap || !Memory.localMap.active) return;
    const scan = Memory.localMap;

    // Rebuild observer map each tick (structure could be destroyed)
    const observerMap = {};
    for (const roomName of scan.observerRooms) {
        const room = Game.rooms[roomName];
        if (!room) continue;
        const observer = room.find(FIND_MY_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_OBSERVER
        })[0];
        if (observer) observerMap[roomName] = observer;
    }

    // Process the room that was queued last tick
    if (scan.lastObservedRoom) {
        const room = Game.rooms[scan.lastObservedRoom];
        if (room) {
            scan.results[scan.lastObservedRoom] = collectRoomData(scan.lastObservedRoom, room);
        }
        scan.scannedCount++;
        scan.lastObservedRoom = null;
    }

    // Finish check
    if (scan.roomsToScan.length === 0) {
        completeScan();
        return;
    }

    // Queue the next room for observation
    const nextRoom = scan.roomsToScan.shift();
    const observer = findObserverForRoom(nextRoom, observerMap);

    if (observer) {
        const result = observer.observeRoom(nextRoom);
        if (result === OK) {
            scan.lastObservedRoom = nextRoom;
        } else {
            // observeRoom failed (e.g. structure busy) — skip and count
            scan.scannedCount++;
        }
    } else {
        // No observer in range for this room — shouldn't happen but handle gracefully
        scan.scannedCount++;
    }

    // Progress log every 100 rooms
    if (scan.scannedCount > 0 && scan.scannedCount % 100 === 0) {
        const pct = ((scan.scannedCount / scan.totalRooms) * 100).toFixed(1);
        console.log(`[LocalMap] Progress: ${scan.scannedCount}/${scan.totalRooms} (${pct}%)`);
    }
}

function cancelLocalMap() {
    if (Memory.localMap && Memory.localMap.active) {
        console.log('[LocalMap] Scan cancelled.');
        delete Memory.localMap;
    } else {
        console.log('[LocalMap] No active scan to cancel.');
    }
}

function getLocalMapStatus() {
    if (!Memory.localMap || !Memory.localMap.active) {
        console.log('[LocalMap] No active scan.');
        return null;
    }
    const scan = Memory.localMap;
    const pct  = ((scan.scannedCount / scan.totalRooms) * 100).toFixed(1);
    const rem  = scan.totalRooms - scan.scannedCount;
    const elapsed = Game.time - scan.startTick;
    console.log('[LocalMap] Status:');
    console.log(`  Progress : ${scan.scannedCount}/${scan.totalRooms} (${pct}%)`);
    console.log(`  Elapsed  : ${elapsed} ticks`);
    console.log(`  Remaining: ~${rem} ticks`);
    return scan;
}

// ─── Report building ─────────────────────────────────────────────────────────

function formatHits(hits) {
    if (!hits || hits === 0) return '-';
    if (hits >= 1000000)   return `${(hits / 1000000).toFixed(1)}M`;
    if (hits >= 1000)      return `${Math.round(hits / 1000)}K`;
    return String(hits);
}

/**
 * Build the report as an array of plain strings.
 * Shared by both the console printer and the notify sender so the
 * content is always identical — only the delivery mechanism differs.
 */
function buildReportLines(results, elapsedTicks) {
    const byPlayer  = {};
    const unclaimed = [];
    const skRooms   = [];
    const highways  = [];

    for (const roomName in results) {
        const d = results[roomName];
        if (d.type === 'highway' || d.type === 'intersection') {
            highways.push(d);
        } else if (d.type === 'sourceKeeper') {
            skRooms.push(d);
        } else if (d.owner) {
            if (!byPlayer[d.owner]) byPlayer[d.owner] = [];
            byPlayer[d.owner].push(d);
        } else {
            unclaimed.push(d);
        }
    }

    const lines = [];
    lines.push('================================================================');
    lines.push('[LocalMap] SCAN COMPLETE');
    lines.push(`  Rooms scanned : ${Object.keys(results).length}`);
    if (elapsedTicks !== undefined) lines.push(`  Time elapsed  : ${elapsedTicks} ticks`);
    lines.push('');

    // ── Player-owned rooms ───────────────────────────────────────────
    const players = Object.keys(byPlayer).sort();
    if (players.length > 0) {
        lines.push(`--- PLAYERS (${players.length} found) ---`);
        for (const player of players) {
            const rooms = byPlayer[player].sort((a, b) => a.room.localeCompare(b.room));
            for (const r of rooms) {
                const flags = [
                    r.safeMode   ? 'SAFE' : '',
                    r.hasNuker   ? 'NKR'  : '',
                    r.hasStorage ? 'STR'  : '',
                    r.hasTerminal? 'TRM'  : '',
                ].filter(Boolean).join('/');

                lines.push(
                    `  ${r.room.padEnd(8)} | ${player.padEnd(16)} | RCL${r.rcl}` +
                    ` | T:${r.towers} Sp:${r.spawns}` +
                    ` | Def:${formatHits(r.avgDefenseHits).padStart(6)}` +
                    ` | Min:${(r.mineral || '-').padEnd(3)}` +
                    (flags ? ` | ${flags}` : '')
                );
            }
        }
        lines.push('');
    } else {
        lines.push('--- PLAYERS: None found ---');
        lines.push('');
    }

    // ── Source Keeper rooms ──────────────────────────────────────────
    if (skRooms.length > 0) {
        lines.push(`--- SOURCE KEEPER ROOMS (${skRooms.length}) ---`);
        for (const r of skRooms.sort((a, b) => a.room.localeCompare(b.room))) {
            lines.push(
                `  ${r.room.padEnd(8)} | Src:${r.sources} | Min:${r.mineral || '-'}`
            );
        }
        lines.push('');
    }

    // ── Highways & intersections ─────────────────────────────────────
    if (highways.length > 0) {
        lines.push(`--- HIGHWAY / INTERSECTION ROOMS (${highways.length}) ---`);
        // Only emit rows that have something interesting (power bank, deposit, etc.)
        // For now just summarise the count; add detail here when depositObserver feeds in
        lines.push(`  ${highways.length} highway/intersection rooms scanned.`);
        lines.push('');
    }

    // ── Unclaimed normal rooms ───────────────────────────────────────
    if (unclaimed.length > 0) {
        lines.push(`--- UNCLAIMED ROOMS (${unclaimed.length}) ---`);
        for (const r of unclaimed.sort((a, b) => a.room.localeCompare(b.room))) {
            lines.push(
                `  ${r.room.padEnd(8)} | Src:${r.sources} | Min:${r.mineral || '-'}`
            );
        }
        lines.push('');
    }

    lines.push('================================================================');
    return lines;
}

// ─── Game.notify chunking ────────────────────────────────────────────────────
//
// Game.notify silently truncates messages that exceed ~1000 chars.
// We split the report into chunks ≤ NOTIFY_CHUNK_MAX chars and send
// each as a separate notification prefixed with "[LocalMap N/T]"
// so the full report is always delivered, just across multiple emails.

function sendChunkedNotify(lines) {
    const chunks = [];
    let current  = '';

    for (const line of lines) {
        // +1 for the newline separator
        const candidate = current.length === 0 ? line : current + '\n' + line;
        if (candidate.length > NOTIFY_CHUNK_MAX) {
            if (current.length > 0) chunks.push(current);
            current = line;
        } else {
            current = candidate;
        }
    }
    if (current.length > 0) chunks.push(current);

    const total = chunks.length;
    for (let i = 0; i < total; i++) {
        Game.notify(`[LocalMap ${i + 1}/${total}]\n${chunks[i]}`, 0);
    }
}

// ─── Scan completion ─────────────────────────────────────────────────────────

function completeScan() {
    const scan = Memory.localMap;
    if (!scan) return;

    const elapsed = Game.time - scan.startTick;
    const lines   = buildReportLines(scan.results, elapsed);

    // Print to console — identical content to the notification
    for (const line of lines) console.log(line);

    // Notify — chunked so nothing is cut off
    sendChunkedNotify(lines);

    delete Memory.localMapResults;
    delete Memory.localMap;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
    start:  startLocalMap,
    run:    run,
    cancel: cancelLocalMap,
    status: getLocalMapStatus,
};

global.localMap       = startLocalMap;
global.localMapCancel = cancelLocalMap;
