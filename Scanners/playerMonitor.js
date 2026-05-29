/**
 * playerMonitor.js - Continuous monitoring of enemy player rooms
 *
 * ═══════════════════════════════════════════════════════════════════
 * CONSOLE COMMANDS:
 * ═══════════════════════════════════════════════════════════════════
 *
 *   monitor('Player', 'WAR')              - Start monitoring with wideScan.
 *   monitor('Player', 'ALLY', ['rooms'])  - Start with known rooms.
 *   monitor('Player')                     - Defaults to ENEMY status.
 *
 *   monitorSetStatus('Player', 'WAR')     - Change a player's status.
 *                                           Takes effect immediately.
 *
 *   monitorAdd('Player', ['rooms'])       - Add rooms to an existing monitor.
 *   monitorRemove('PlayerName')           - Stop monitoring, clear all state.
 *
 *   monitorStatus()                       - Show all monitored players,
 *                                           statuses, poll timers, rooms.
 *
 *   monitorPause() / monitorResume()      - Pause/resume all scanning.
 *
 * ═══════════════════════════════════════════════════════════════════
 * PLAYER STATUSES:
 * ═══════════════════════════════════════════════════════════════════
 *
 *   ALLY     - Poll every 1000 ticks. Only tracks room health:
 *              RCL changes, room lost, no creeps, spawns drained,
 *              towers empty, safe mode, new room claimed.
 *
 *   NEUTRAL  - Poll every 1000 ticks. Tracks room health plus
 *              threat indicators: nuker, military, boosted.
 *
 *   ENEMY    - Poll every 1000 ticks. All alerts.
 *
 *   WAR      - Poll every 100 ticks.  All alerts.
 *
 * ═══════════════════════════════════════════════════════════════════
 * ALERTS TRACKED:
 * ═══════════════════════════════════════════════════════════════════
 *
 *   ALL STATUSES:
 *     - RCL level changed (upgrade or downgrade)
 *     - Room lost / unclaimed
 *     - Room abandoned (0 creeps, nothing spawning)
 *     - Spawns & extensions drained (0 energy)
 *     - All towers below 10 energy
 *     - Safe mode activated
 *     - Player claimed a new room
 *
 *   NEUTRAL, ENEMY, WAR only:
 *     - Nuker constructed / being filled (energy and ghodium tracked separately)
 *     - Military creeps (ATTACK, RANGED_ATTACK, HEAL)
 *     - Boosted creeps detected
 *
 *   ENEMY, WAR only:
 *     - Power loaded into power spawn
 *
 *   WAR only:
 *     - Ghodium detected in terminal (possible nuke preparation)
 *
 * ═══════════════════════════════════════════════════════════════════
 * INTEGRATION:
 * ═══════════════════════════════════════════════════════════════════
 *
 *   const playerMonitor = require('playerMonitor');
 *   profiler.registerObject(playerMonitor, 'playerMonitor');
 *
 *   // In main loop (every tick, no modulo):
 *   profileSection('playerMonitor.run', function(){ playerMonitor.run(); });
 *
 * SCAN CADENCE:
 *   - Poll interval is per-player based on status (100 or 1000 ticks).
 *   - During a cycle, one room is scanned per tick (pipelined
 *     observe-then-read), so N rooms take N+1 ticks.
 *   - Between cycles the observers are free for other modules.
 *   - Every 200 000 ticks a full wideScan rescan is triggered per
 *     monitored player to discover newly claimed rooms.
 *
 * NOTE: Only one wideScan can run at a time. Rescans are queued and
 * processed sequentially. While a rescan wideScan is active, the
 * normal monitoring cycle still runs.
 */

const OBSERVER_RANGE = 10;
const RESCAN_INTERVAL = 200000;  // ticks between full wideScan rescans
const NOTIFY_COOLDOWN = 30;      // Game.notify group interval (minutes)

// ─── Player status definitions ──────────────────────────────────

const STATUS = {
    ALLY:    'ALLY',
    NEUTRAL: 'NEUTRAL',
    ENEMY:   'ENEMY',
    WAR:     'WAR'
};

// Poll interval per status (ticks between scan cycles)
const POLL_INTERVAL = {
    ALLY:    1000,
    NEUTRAL: 1000,
    ENEMY:   1000,
    WAR:     100
};

// Which alert types each status cares about
const ALERT_FILTER = {
    ALLY: [
        'RCL_UPGRADED', 'RCL_DOWNGRADED', 'ROOM_LOST', 'NO_CREEPS',
        'SPAWNS_DRAINED', 'TOWERS_EMPTY', 'SAFE_MODE', 'NEW_ROOM'
    ],
    NEUTRAL: [
        'RCL_UPGRADED', 'RCL_DOWNGRADED', 'ROOM_LOST', 'NO_CREEPS',
        'SPAWNS_DRAINED', 'TOWERS_EMPTY', 'SAFE_MODE', 'NEW_ROOM',
        'NUKER_BUILT', 'NUKER_FILLING_G', 'NUKER_FILLING_E',
        'MILITARY_CREEPS', 'BOOSTED_CREEPS'
    ],
    ENEMY: null,   // null = all alerts
    WAR:   null    // null = all alerts
};

// ─── Geometry helpers (same as wideScan.js) ─────────────────────

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

function chebyshevDistance(a, b) {
    return Math.max(Math.abs(a.wx - b.wx), Math.abs(a.wy - b.wy));
}

// ─── Observer helpers ───────────────────────────────────────────

/**
 * Find all observers in owned rooms.
 * @returns {Object} { roomName: StructureObserver }
 */
function findAllObservers() {
    const map = {};
    for (const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if (!room.controller || !room.controller.my) continue;
        const obs = room.find(FIND_MY_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_OBSERVER
        })[0];
        if (obs) map[roomName] = obs;
    }
    return map;
}

/**
 * Assign the minimum set of observers to cover a list of target rooms.
 * Prefers a single observer when possible.
 *
 * @param {string[]} targetRooms
 * @returns {Object|null} { targetRoom: observerRoomName } or null if
 *                        some rooms are unreachable.
 */
function assignObservers(targetRooms) {
    const observerRooms = Object.keys(findAllObservers());
    if (observerRooms.length === 0) return null;

    // Pre-compute which observers can reach each target
    const reachMap = {}; // targetRoom -> [observerRoom, ...]
    for (const target of targetRooms) {
        const tc = parseRoomName(target);
        if (!tc) continue;
        reachMap[target] = [];
        for (const obsRoom of observerRooms) {
            const oc = parseRoomName(obsRoom);
            if (oc && chebyshevDistance(tc, oc) <= OBSERVER_RANGE) {
                reachMap[target].push(obsRoom);
            }
        }
    }

    // Try to find a single observer that covers all rooms
    for (const obsRoom of observerRooms) {
        let coversAll = true;
        for (const target of targetRooms) {
            if (!reachMap[target] || !reachMap[target].includes(obsRoom)) {
                coversAll = false;
                break;
            }
        }
        if (coversAll) {
            const assignments = {};
            for (const target of targetRooms) {
                assignments[target] = obsRoom;
            }
            return assignments;
        }
    }

    // Greedy set cover for minimum observers
    const uncovered = new Set(targetRooms);
    const assignments = {};
    const unreachable = [];

    while (uncovered.size > 0) {
        let bestObs = null;
        let bestTargets = [];

        for (const obsRoom of observerRooms) {
            const covered = [];
            for (const target of uncovered) {
                if (reachMap[target] && reachMap[target].includes(obsRoom)) {
                    covered.push(target);
                }
            }
            if (covered.length > bestTargets.length) {
                bestObs = obsRoom;
                bestTargets = covered;
            }
        }

        if (!bestObs || bestTargets.length === 0) {
            for (const room of uncovered) {
                unreachable.push(room);
            }
            break;
        }

        for (const target of bestTargets) {
            assignments[target] = bestObs;
            uncovered.delete(target);
        }
    }

    if (unreachable.length > 0) {
        console.log('[Monitor] WARNING: These rooms are outside all observer ranges: ' +
                    unreachable.join(', '));
    }

    return assignments;
}

// ─── RemoteSupply integration helper ────────────────────────────

/**
 * Returns true if remoteSupplyManager has an active order watching
 * roomName as its recipient. Reads Memory directly — no require(),
 * no object allocation, O(orders) which is typically 1–3 entries.
 */
function _isRemoteSupplyRoom(roomName) {
    var orders = Memory.remoteSupplyOrders;
    if (!orders) return false;
    for (var key in orders) {
        var o = orders[key];
        if (o && o.active && o.recipientRoom === roomName) return true;
    }
    return false;
}

// ─── Memory initialization ──────────────────────────────────────

function ensureMemory() {
    if (!Memory.playerMonitor) {
        Memory.playerMonitor = {
            players: {},     // { playerName: { rooms, observers, state, status, lastPoll } }
            paused: false,
            lastRescan: 0,
            rescanQueue: [],
            pendingWideScan: null,  // { player, snapshotRooms } — waiting for wideScan to finish
            cycle: {
                active: false,
                queue: [],
                index: 0,
                lastObserved: null
            }
        };
    }
    return Memory.playerMonitor;
}

// ─── Alert helpers ──────────────────────────────────────────────

function fireAlert(playerName, room, type, message) {
    const mem = ensureMemory();

    const playerData = mem.players[playerName];
    if (playerData) {
        const status = playerData.status || STATUS.ENEMY;
        const filter = ALERT_FILTER[status];
        if (filter && !filter.includes(type)) {
            return;
        }
    }

    const tag = '[Monitor][' + playerName + '][' + room + '] ';
    console.log(tag + type + ': ' + message);

    Game.notify('[Monitor] ' + playerName + ' | ' + room + ' | ' + type + ': ' + message,
                NOTIFY_COOLDOWN);
}

// ─── Room analysis ──────────────────────────────────────────────

/**
 * Analyze a visible room and fire alerts based on state changes.
 *
 * State fields:
 *   owned:          bool
 *   rcl:            int
 *   safeMode:       bool
 *   hasNuker:       bool
 *   nukerHasG:      bool
 *   nukerHasE:      bool
 *   hasMilitary:    bool
 *   hasBoosted:     bool
 *   hasCreeps:      bool
 *   spawnsDrained:  bool
 *   spawnExtEnergy: number  (only if remoteSupplyManager is watching this room)
 *   storageEnergy:  number  (only if remoteSupplyManager is watching this room)
 *   hasPower:       bool    (ENEMY/WAR only)
 *   towersLow:      bool
 *   terminalHasG:   bool    (WAR only)
 *   t:              int     Game.time of last scan
 */
function analyzeRoom(room, playerName, prev, status) {
    const roomName = room.name;
    const s = {};
    const first = Object.keys(prev).length === 0;

    // ── Owner check ─────────────────────────────────────────────
    const owner = (room.controller && room.controller.owner)
                ? room.controller.owner.username : null;

    if (owner !== playerName) {
        if (!first && prev.owned) {
            fireAlert(playerName, roomName, 'ROOM_LOST',
                      'Room is no longer owned by ' + playerName +
                      (owner ? ' (now owned by ' + owner + ')' : ' (unclaimed)'));
        }
        s.owned = false;
        s.t = Game.time;
        return s;
    }
    s.owned = true;

    // ── Controller / RCL ────────────────────────────────────────
    const rcl = room.controller ? room.controller.level : 0;
    s.rcl = rcl;

    if (!first && prev.rcl !== undefined && prev.rcl !== rcl) {
        const dir = rcl > prev.rcl ? 'UPGRADED' : 'DOWNGRADED';
        fireAlert(playerName, roomName, 'RCL_' + dir,
                  'RCL changed from ' + prev.rcl + ' to ' + rcl);
    }

    // ── Safe mode ───────────────────────────────────────────────
    s.safeMode = room.controller ? !!room.controller.safeMode : false;

    if (!first && !prev.safeMode && s.safeMode) {
        fireAlert(playerName, roomName, 'SAFE_MODE',
                  'Safe mode activated! ' + room.controller.safeMode + ' ticks remaining');
    }

    // ── Nuker ───────────────────────────────────────────────────
    const nukers = room.find(FIND_HOSTILE_STRUCTURES, {
        filter: st => st.structureType === STRUCTURE_NUKER
    });
    s.hasNuker = nukers.length > 0;

    if (s.hasNuker) {
        const nuker = nukers[0];
        const gAmt = nuker.store.getUsedCapacity(RESOURCE_GHODIUM) || 0;
        const eAmt = nuker.store.getUsedCapacity(RESOURCE_ENERGY)  || 0;
        s.nukerHasG = gAmt > 0;
        s.nukerHasE = eAmt > 0;

        if (!first) {
            if (!prev.hasNuker) {
                fireAlert(playerName, roomName, 'NUKER_BUILT',
                          'A nuker has been constructed!');
            }
            if (!prev.nukerHasG && s.nukerHasG) {
                fireAlert(playerName, roomName, 'NUKER_FILLING_G',
                          'Nuker ghodium filling started (now ' + gAmt + '/5000)');
            }
            if (!prev.nukerHasE && s.nukerHasE) {
                fireAlert(playerName, roomName, 'NUKER_FILLING_E',
                          'Nuker energy filling started (now ' + eAmt + '/300000)');
            }
        }
    } else {
        s.nukerHasG = false;
        s.nukerHasE = false;
    }

    // ── Creeps ──────────────────────────────────────────────────
    const hostileCreeps = room.find(FIND_HOSTILE_CREEPS, {
        filter: c => c.owner.username === playerName
    });

    s.hasCreeps = hostileCreeps.length > 0;

    const militaryParts = [ATTACK, RANGED_ATTACK, HEAL];
    const militaryCreeps = hostileCreeps.filter(c =>
        c.body.some(p => militaryParts.includes(p.type))
    );
    s.hasMilitary = militaryCreeps.length > 0;

    if (!first && !prev.hasMilitary && s.hasMilitary) {
        const summary = militaryCreeps.map(c => {
            const parts = {};
            for (const p of c.body) {
                if (militaryParts.includes(p.type)) {
                    parts[p.type] = (parts[p.type] || 0) + 1;
                }
            }
            return Object.keys(parts).map(k => parts[k] + k.charAt(0).toUpperCase()).join('/');
        });
        fireAlert(playerName, roomName, 'MILITARY_CREEPS',
                  militaryCreeps.length + ' military creep(s) detected: ' +
                  summary.join(', '));
    }

    const boostedCreeps = hostileCreeps.filter(c =>
        c.body.some(p => p.boost)
    );
    s.hasBoosted = boostedCreeps.length > 0;

    if (!first && !prev.hasBoosted && s.hasBoosted) {
        const boostSet = new Set();
        for (const c of boostedCreeps) {
            for (const p of c.body) {
                if (p.boost) boostSet.add(p.boost);
            }
        }
        fireAlert(playerName, roomName, 'BOOSTED_CREEPS',
                  boostedCreeps.length + ' boosted creep(s). Boosts: ' +
                  Array.from(boostSet).join(', '));
    }

    if (!first && prev.hasCreeps && !s.hasCreeps) {
        const spawns = room.find(FIND_HOSTILE_STRUCTURES, {
            filter: st => st.structureType === STRUCTURE_SPAWN
        });
        const anySpawning = spawns.some(sp => sp.spawning);
        if (!anySpawning) {
            fireAlert(playerName, roomName, 'NO_CREEPS',
                      'No creeps detected and no spawns active — room may be abandoned or under attack');
        }
    }

    // ── Spawns & extensions ─────────────────────────────────────
    const spawnExtensions = room.find(FIND_HOSTILE_STRUCTURES, {
        filter: st => st.structureType === STRUCTURE_SPAWN ||
                      st.structureType === STRUCTURE_EXTENSION
    });

    if (spawnExtensions.length > 0) {
        const totalEnergy = spawnExtensions.reduce((sum, st) => {
            return sum + (st.store ? st.store.getUsedCapacity(RESOURCE_ENERGY) || 0 : 0);
        }, 0);
        s.spawnsDrained = totalEnergy === 0;

        // Only store exact figure if remoteSupplyManager is watching this room.
        // totalEnergy is already computed above so this costs nothing extra.
        if (_isRemoteSupplyRoom(roomName)) {
            s.spawnExtEnergy = totalEnergy;
        }
    } else {
        s.spawnsDrained = true;
        if (_isRemoteSupplyRoom(roomName)) {
            s.spawnExtEnergy = 0;
        }
    }

    if (!first && s.spawnsDrained && !prev.spawnsDrained) {
        fireAlert(playerName, roomName, 'SPAWNS_DRAINED',
                  'All spawns and extensions have 0 energy');
    }

    // ── Storage energy (remoteSupply rooms only) ─────────────────
    // The find() call is skipped entirely for rooms we don't care about.
    if (_isRemoteSupplyRoom(roomName)) {
        const storages = room.find(FIND_HOSTILE_STRUCTURES, {
            filter: st => st.structureType === STRUCTURE_STORAGE
        });
        s.storageEnergy = (storages.length > 0 && storages[0].store)
            ? (storages[0].store.getUsedCapacity(RESOURCE_ENERGY) || 0)
            : 0;
    }

    // ── Power spawn (ENEMY/WAR only) ─────────────────────────────
    if (status === STATUS.ENEMY || status === STATUS.WAR) {
        const powerSpawns = room.find(FIND_HOSTILE_STRUCTURES, {
            filter: st => st.structureType === STRUCTURE_POWER_SPAWN
        });

        if (powerSpawns.length > 0) {
            const ps = powerSpawns[0];
            s.hasPower = (ps.store ? (ps.store.getUsedCapacity(RESOURCE_POWER) || 0) : 0) > 0;
        } else {
            s.hasPower = false;
        }

        if (!first && s.hasPower && !prev.hasPower) {
            fireAlert(playerName, roomName, 'POWER_DETECTED',
                      'Power loaded into power spawn');
        }
    }

    // ── Terminal ghodium (WAR only) ──────────────────────────────
    if (status === STATUS.WAR) {
        const terminals = room.find(FIND_HOSTILE_STRUCTURES, {
            filter: st => st.structureType === STRUCTURE_TERMINAL
        });

        if (terminals.length > 0) {
            const gAmt = terminals[0].store.getUsedCapacity(RESOURCE_GHODIUM) || 0;
            s.terminalHasG = gAmt > 0;
        } else {
            s.terminalHasG = false;
        }

        if (!first && !prev.terminalHasG && s.terminalHasG) {
            fireAlert(playerName, roomName, 'TERMINAL_G',
                      'Ghodium detected in terminal — possible nuke preparation');
        }
    }

    // ── Towers ──────────────────────────────────────────────────
    const towers = room.find(FIND_HOSTILE_STRUCTURES, {
        filter: st => st.structureType === STRUCTURE_TOWER
    });

    if (towers.length > 0) {
        s.towersLow = towers.every(t => {
            return (t.store ? (t.store.getUsedCapacity(RESOURCE_ENERGY) || 0) : 0) < 10;
        });
    } else {
        s.towersLow = false;
    }

    if (!first && s.towersLow && !prev.towersLow) {
        fireAlert(playerName, roomName, 'TOWERS_EMPTY',
                  'All ' + towers.length + ' tower(s) have less than 10 energy');
    }

    s.t = Game.time;
    return s;
}

// ─── Scan cycle management ──────────────────────────────────────

function buildScanQueue() {
    const mem = ensureMemory();
    const queue = [];
    const playersIncluded = [];

    for (const playerName in mem.players) {
        const playerData = mem.players[playerName];
        if (!playerData.rooms || playerData.rooms.length === 0) continue;
        if (!playerData.observers) continue;

        const status = playerData.status || STATUS.ENEMY;
        const interval = POLL_INTERVAL[status] || 1000;
        const lastPoll = playerData.lastPoll || 0;

        if (Game.time - lastPoll < interval) continue;

        playersIncluded.push(playerName);

        for (const room of playerData.rooms) {
            const observer = playerData.observers[room];
            if (!observer) continue;
            queue.push({ player: playerName, room: room, observer: observer });
        }
    }

    return { queue, playersIncluded };
}

function startCycle() {
    const mem = ensureMemory();
    const { queue, playersIncluded } = buildScanQueue();

    if (queue.length === 0) return;

    mem.cycle = {
        active: true,
        queue: queue,
        index: 0,
        lastObserved: null,
        playersInCycle: playersIncluded
    };
}

function processCycleTick() {
    const mem = ensureMemory();
    const cycle = mem.cycle;
    if (!cycle || !cycle.active) return;

    // ── Step 1: Read the room we observed last tick ─────────────
    if (cycle.lastObserved) {
        const lo = cycle.lastObserved;
        const room = Game.rooms[lo.room];

        if (room) {
            const playerData = mem.players[lo.player];
            if (playerData) {
                if (!playerData.state) playerData.state = {};
                const prevState = playerData.state[lo.room] || {};
                const status = playerData.status || STATUS.ENEMY;
                playerData.state[lo.room] = analyzeRoom(room, lo.player, prevState, status);
            }
        }
        cycle.lastObserved = null;
    }

    // ── Step 2: Observe the next room in queue ──────────────────
    if (cycle.index >= cycle.queue.length) {
        if (cycle.playersInCycle) {
            for (const playerName of cycle.playersInCycle) {
                if (mem.players[playerName]) {
                    mem.players[playerName].lastPoll = Game.time;
                }
            }
        }
        cycle.active = false;
        return;
    }

    const entry = cycle.queue[cycle.index];
    cycle.index++;

    const obsRoom = Game.rooms[entry.observer];
    if (!obsRoom) return;

    const observer = obsRoom.find(FIND_MY_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_OBSERVER
    })[0];

    if (!observer) return;

    const result = observer.observeRoom(entry.room);
    if (result === OK) {
        cycle.lastObserved = entry;
    }
}

// ─── WideScan rescan integration ────────────────────────────────

function handleRescans() {
    const mem = ensureMemory();

    if (Game.time - (mem.lastRescan || 0) >= RESCAN_INTERVAL) {
        const players = Object.keys(mem.players);
        if (players.length > 0) {
            mem.rescanQueue = players.slice();
            mem.lastRescan = Game.time;
            console.log('[Monitor] Queuing wideScan rescan for ' + players.length + ' player(s)');
        }
    }

    if (!mem.rescanQueue || mem.rescanQueue.length === 0) return;

    if (mem.pendingWideScan) return;
    if (Memory.wideScan && Memory.wideScan.active) return;

    const nextPlayer = mem.rescanQueue.shift();
    if (nextPlayer && mem.players[nextPlayer]) {
        const wideScan = require('wideScan');
        console.log('[Monitor] Starting wideScan rescan for: ' + nextPlayer);
        wideScan.start(nextPlayer);

        mem.pendingWideScan = {
            player: nextPlayer,
            snapshotRooms: [],
            isRescan: true
        };
    }
}

function updatePlayerRooms(playerName, rooms) {
    const mem = ensureMemory();
    if (!mem.players[playerName]) {
        console.log('[Monitor] Player ' + playerName + ' is not being monitored.');
        return;
    }

    const oldRooms = new Set(mem.players[playerName].rooms || []);
    const newRooms = rooms.filter(r => !oldRooms.has(r));

    if (newRooms.length > 0) {
        for (const room of newRooms) {
            fireAlert(playerName, room, 'NEW_ROOM',
                      playerName + ' has claimed a new room: ' + room);
        }
    }

    mem.players[playerName].rooms = rooms;

    const obs = assignObservers(rooms);
    if (obs) {
        mem.players[playerName].observers = obs;
        const uniqueObs = [...new Set(Object.values(obs))];
        console.log('[Monitor] Updated ' + playerName + ': ' + rooms.length +
                    ' room(s), ' + uniqueObs.length + ' observer(s): ' +
                    uniqueObs.join(', '));
    }
}

// ─── Public API / Console commands ──────────────────────────────

function monitor(playerName, statusOrRooms, rooms) {
    if (!playerName || typeof playerName !== 'string') {
        console.log('[Monitor] Usage: monitor("PlayerName", "STATUS") or monitor("PlayerName", "STATUS", ["room1","room2"])');
        console.log('[Monitor] Valid statuses: ALLY, NEUTRAL, ENEMY, WAR');
        return;
    }

    const mem = ensureMemory();

    let status = STATUS.ENEMY;
    let roomList = null;

    if (typeof statusOrRooms === 'string' && STATUS[statusOrRooms.toUpperCase()]) {
        status = statusOrRooms.toUpperCase();
        if (rooms && Array.isArray(rooms) && rooms.length > 0) {
            roomList = rooms;
        }
    } else if (Array.isArray(statusOrRooms) && statusOrRooms.length > 0) {
        roomList = statusOrRooms;
    } else if (typeof statusOrRooms === 'string') {
        console.log('[Monitor] Unknown status: "' + statusOrRooms + '". Valid: ALLY, NEUTRAL, ENEMY, WAR');
        return;
    }

    if (roomList) {
        return monitorAdd(playerName, roomList, status);
    }

    if (mem.players[playerName] && mem.players[playerName].rooms &&
        mem.players[playerName].rooms.length > 0) {
        const oldStatus = mem.players[playerName].status || STATUS.ENEMY;
        if (oldStatus !== status) {
            mem.players[playerName].status = status;
            console.log('[Monitor] Updated ' + playerName + ' status: ' +
                        oldStatus + ' → ' + status);
        } else {
            console.log('[Monitor] Already monitoring ' + playerName + ' as ' + status + ' with ' +
                        mem.players[playerName].rooms.length + ' room(s). ' +
                        'Use monitorSetStatus() to change, monitorRemove() to reset.');
        }
        return;
    }

    if (mem.pendingWideScan && mem.pendingWideScan.player === playerName) {
        console.log('[Monitor] A wideScan for ' + playerName + ' is already in progress.');
        return;
    }

    if (Memory.wideScan && Memory.wideScan.active) {
        console.log('[Monitor] Another wideScan is currently active (target: ' +
                    Memory.wideScan.targetPlayer + '). Please wait for it to finish, then retry.');
        return;
    }

    const wideScan = require('wideScan');
    wideScan.start(playerName);

    mem.pendingWideScan = {
        player: playerName,
        status: status,
        snapshotRooms: []
    };

    console.log('[Monitor] WideScan started for ' + playerName + ' (status: ' + status +
                '). Monitoring will begin automatically when the scan finishes.');
}

function monitorAdd(playerName, rooms, status) {
    if (!playerName || !rooms || !Array.isArray(rooms) || rooms.length === 0) {
        console.log('[Monitor] Usage: monitorAdd("PlayerName", ["room1", "room2"], "STATUS")');
        return;
    }

    const mem = ensureMemory();

    if (!mem.players[playerName]) {
        mem.players[playerName] = {
            rooms: [],
            observers: {},
            state: {},
            status: (status && STATUS[status.toUpperCase()]) ? status.toUpperCase() : STATUS.ENEMY,
            lastPoll: 0
        };
    } else if (status && STATUS[status.toUpperCase()]) {
        mem.players[playerName].status = status.toUpperCase();
    }

    const existingSet = new Set(mem.players[playerName].rooms || []);
    let addedCount = 0;
    for (const room of rooms) {
        if (!existingSet.has(room)) {
            existingSet.add(room);
            addedCount++;
        }
    }

    const allRooms = Array.from(existingSet);
    mem.players[playerName].rooms = allRooms;

    const obs = assignObservers(allRooms);
    if (obs) {
        mem.players[playerName].observers = obs;
        const uniqueObs = [...new Set(Object.values(obs))];
        const playerStatus = mem.players[playerName].status || STATUS.ENEMY;
        console.log('[Monitor] Now monitoring ' + playerName + ' [' + playerStatus + ']: ' +
                    allRooms.length + ' room(s) via ' + uniqueObs.length +
                    ' observer(s): ' + uniqueObs.join(', ') +
                    ' (poll: ' + POLL_INTERVAL[playerStatus] + ' ticks)');

        if (addedCount > 0) {
            console.log('[Monitor] Added ' + addedCount + ' new room(s).');
        }
    } else {
        console.log('[Monitor] ERROR: No observers available to cover these rooms.');
    }
}

function monitorRemove(playerName) {
    const mem = ensureMemory();
    let cleared = false;

    if (mem.players[playerName]) {
        delete mem.players[playerName];
        if (mem.rescanQueue) {
            mem.rescanQueue = mem.rescanQueue.filter(p => p !== playerName);
        }
        if (mem.cycle && mem.cycle.active && mem.cycle.queue) {
            mem.cycle.queue = mem.cycle.queue.filter(e => e.player !== playerName);
        }
        cleared = true;
    }

    if (mem.pendingWideScan && mem.pendingWideScan.player === playerName) {
        delete mem.pendingWideScan;
        cleared = true;
    }

    if (cleared) {
        console.log('[Monitor] Stopped monitoring ' + playerName + ' — all state cleared.');
    } else {
        console.log('[Monitor] ' + playerName + ' is not being monitored.');
    }
}

function monitorStatus() {
    const mem = ensureMemory();
    const players = Object.keys(mem.players);

    if (players.length === 0 && !mem.pendingWideScan) {
        console.log('[Monitor] No players being monitored.');
        return;
    }

    console.log('════════════════════ PLAYER MONITOR STATUS ════════════════════');
    console.log('  Paused: ' + (mem.paused ? 'YES' : 'no'));

    if (mem.pendingWideScan) {
        const p = mem.pendingWideScan;
        const scanProgress = Memory.wideScan
            ? (Memory.wideScan.scannedCount + '/' + Memory.wideScan.totalRooms)
            : 'finishing...';
        console.log('  WideScan in progress: ' + p.player +
                    (p.isRescan ? ' (rescan)' : ' (initial)') +
                    ' — ' + scanProgress +
                    ' — ' + (p.snapshotRooms || []).length + ' room(s) found so far');
    }

    if (players.length > 0) {
        console.log('  Next rescan in: ' +
                    (RESCAN_INTERVAL - (Game.time - (mem.lastRescan || 0))) + ' ticks');
    }

    if (mem.cycle && mem.cycle.active) {
        console.log('  Scan cycle: ACTIVE (' + mem.cycle.index + '/' +
                    mem.cycle.queue.length + ')');
    }

    console.log('');

    for (const playerName of players) {
        const pd = mem.players[playerName];
        const rooms = pd.rooms || [];
        const uniqueObs = pd.observers
            ? [...new Set(Object.values(pd.observers))]
            : [];
        const status = pd.status || STATUS.ENEMY;
        const interval = POLL_INTERVAL[status] || 1000;
        const lastPoll = pd.lastPoll || 0;
        const ticksUntilPoll = Math.max(0, interval - (Game.time - lastPoll));

        console.log('  ' + playerName + ' [' + status + '] (poll: ' + interval + ' ticks):');
        console.log('    Rooms (' + rooms.length + '): ' + rooms.sort().join(', '));
        console.log('    Observers (' + uniqueObs.length + '): ' + uniqueObs.join(', '));
        console.log('    Next poll in: ' + ticksUntilPoll + ' ticks');

        if (pd.state) {
            const staleRooms = [];
            for (const room of rooms) {
                const rs = pd.state[room];
                if (rs && rs.t) {
                    const age = Game.time - rs.t;
                    if (age > interval * 3) {
                        staleRooms.push(room + ' (' + age + ' ticks ago)');
                    }
                }
            }
            if (staleRooms.length > 0) {
                console.log('    Stale scans: ' + staleRooms.join(', '));
            }
        }
    }

    console.log('════════════════════════════════════════════════════════════════');
}

function monitorPause() {
    const mem = ensureMemory();
    mem.paused = true;
    console.log('[Monitor] Scanning paused.');
}

function monitorResume() {
    const mem = ensureMemory();
    mem.paused = false;
    console.log('[Monitor] Scanning resumed.');
}

function monitorSetStatus(playerName, newStatus) {
    if (!playerName || !newStatus) {
        console.log('[Monitor] Usage: monitorSetStatus("PlayerName", "STATUS")');
        console.log('[Monitor] Valid statuses: ALLY, NEUTRAL, ENEMY, WAR');
        return;
    }

    const upper = newStatus.toUpperCase();
    if (!STATUS[upper]) {
        console.log('[Monitor] Unknown status: "' + newStatus + '". Valid: ALLY, NEUTRAL, ENEMY, WAR');
        return;
    }

    const mem = ensureMemory();
    if (!mem.players[playerName]) {
        console.log('[Monitor] ' + playerName + ' is not being monitored.');
        return;
    }

    const oldStatus = mem.players[playerName].status || STATUS.ENEMY;
    mem.players[playerName].status = upper;
    mem.players[playerName].lastPoll = 0;

    const alerts = ALERT_FILTER[upper]
        ? ALERT_FILTER[upper].length + ' alert types'
        : 'all alert types';

    console.log('[Monitor] ' + playerName + ': ' + oldStatus + ' → ' + upper +
                ' (poll: ' + POLL_INTERVAL[upper] + ' ticks, tracking ' + alerts + ')');
}

// ─── Main run() function ────────────────────────────────────────

function run() {
    const mem = ensureMemory();

    if (mem.pendingWideScan) {
        const pending = mem.pendingWideScan;

        if (Memory.wideScan && Memory.wideScan.active &&
            Memory.wideScan.targetPlayer === pending.player) {
            pending.snapshotRooms = (Memory.wideScan.foundRooms || []).slice();
        } else if (!Memory.wideScan || !Memory.wideScan.active) {
            const rooms = pending.snapshotRooms || [];
            const playerName = pending.player;
            delete mem.pendingWideScan;

            if (rooms.length > 0) {
                console.log('[Monitor] WideScan complete. Found ' + rooms.length +
                            ' room(s) for ' + playerName + ': ' + rooms.sort().join(', '));
                if (pending.isRescan) {
                    updatePlayerRooms(playerName, rooms);
                } else {
                    monitorAdd(playerName, rooms, pending.status);
                }
            } else {
                console.log('[Monitor] WideScan complete. No rooms found for ' +
                            playerName + ' within observer range.');
            }
        }
    }

    if (mem.paused) return;
    if (Object.keys(mem.players).length === 0) return;

    if (Game.time % 1000 === 0) {
        handleRescans();
    }

    if (!mem.cycle || !mem.cycle.active) {
        startCycle();
    }

    if (mem.cycle && mem.cycle.active) {
        processCycleTick();
    }
}

// ─── Exports ────────────────────────────────────────────────────

module.exports = {
    run:                run,
    monitor:            monitor,
    monitorAdd:         monitorAdd,
    monitorRemove:      monitorRemove,
    monitorSetStatus:   monitorSetStatus,
    monitorStatus:      monitorStatus,
    monitorPause:       monitorPause,
    monitorResume:      monitorResume,
    updatePlayerRooms:  updatePlayerRooms,
    analyzeRoom:        analyzeRoom
};

// Global console commands
global.monitor            = monitor;
global.monitorAdd         = monitorAdd;
global.monitorRemove      = monitorRemove;
global.monitorSetStatus   = monitorSetStatus;
global.monitorStatus      = monitorStatus;
global.monitorPause       = monitorPause;
global.monitorResume      = monitorResume;
global.monitorUpdateRooms = updatePlayerRooms;