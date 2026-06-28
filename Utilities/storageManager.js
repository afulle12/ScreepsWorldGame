/**
 * storageManager.js
 * ─────────────────
 * Centralized inventory ledger for Screeps.
 *
 * Prevents competing systems (factory, market, labs, etc.) from fighting
 * over the same resources by tracking reservations per room/building/program.
 *
 * API:
 *   reserve(roomName, material, building, program, amount)
 *   unReserve(roomName, material, building, program)
 *   transfer(roomName, material, building, fromProgram, toProgram, [amount])
 *   storageFind(roomName, material)   — roomName can be 'all'
 *                                      — material can be a constant or 'NATIVE_RESOURCES'
 *   getUnreserved(roomName)           — terminal/storage maps of available inventory
 *   printUnreserved(roomName)         — pretty-print unreserved inventory to console
 *   cleanStale([maxAge])             — purge reservations older than maxAge ticks (default 20000)
 *   listReservations() — all reservations everywhere
 *   listReservations('E2N46') — just one room
 *   listReservations(null, 'marketSell') — all rooms, filtered to one program
 *   listReservations('E2N46', 'marketSell') — both filters
 *   printFind(roomName, material) — pretty-print storageFind results to console
 *
 * Exposed constants:
 *   MINERAL_TO_BAR — maps raw mineral constants to their compressed bar
 *   BAR_TO_MINERAL — reverse lookup: bar → mineral
 */


// ─── MINERAL → COMPRESSED BAR MAPPING ────────────────────────────────
const MINERAL_TO_BAR = {
    [RESOURCE_HYDROGEN]:  RESOURCE_REDUCTANT,
    [RESOURCE_OXYGEN]:    RESOURCE_OXIDANT,
    [RESOURCE_UTRIUM]:    RESOURCE_UTRIUM_BAR,
    [RESOURCE_LEMERGIUM]: RESOURCE_LEMERGIUM_BAR,
    [RESOURCE_KEANIUM]:   RESOURCE_KEANIUM_BAR,
    [RESOURCE_ZYNTHIUM]:  RESOURCE_ZYNTHIUM_BAR,
    [RESOURCE_CATALYST]:  RESOURCE_PURIFIER,
};

// Reverse lookup: bar → mineral
const BAR_TO_MINERAL = {};
for (const min in MINERAL_TO_BAR) {
    BAR_TO_MINERAL[MINERAL_TO_BAR[min]] = min;
}

// ─── DEPENDENCY ──────────────────────────────────────────────────────
const getRoomState = require('getRoomState');

// ─── HELPERS ─────────────────────────────────────────────────────────

/**
 * Return the native mineral type for a room via getRoomState cache.
 */
function getRoomMineral(roomName) {
    const state = getRoomState.get(roomName);
    if (!state || !state.minerals || state.minerals.length === 0) return null;
    return state.minerals[0].mineralType;
}

// Map 'RESOURCE_XXX' string names to their actual constant values
// so console users can type storageFind('all', 'RESOURCE_OXYGEN') with quotes
const RESOURCE_NAME_MAP = {
    'RESOURCE_HYDROGEN': RESOURCE_HYDROGEN, 'RESOURCE_OXYGEN': RESOURCE_OXYGEN,
    'RESOURCE_UTRIUM': RESOURCE_UTRIUM, 'RESOURCE_LEMERGIUM': RESOURCE_LEMERGIUM,
    'RESOURCE_KEANIUM': RESOURCE_KEANIUM, 'RESOURCE_ZYNTHIUM': RESOURCE_ZYNTHIUM,
    'RESOURCE_CATALYST': RESOURCE_CATALYST, 'RESOURCE_ENERGY': RESOURCE_ENERGY,
    'RESOURCE_POWER': RESOURCE_POWER, 'RESOURCE_OPS': RESOURCE_OPS,
    'RESOURCE_GHODIUM': RESOURCE_GHODIUM,
    // Bars
    'RESOURCE_REDUCTANT': RESOURCE_REDUCTANT, 'RESOURCE_OXIDANT': RESOURCE_OXIDANT,
    'RESOURCE_UTRIUM_BAR': RESOURCE_UTRIUM_BAR, 'RESOURCE_LEMERGIUM_BAR': RESOURCE_LEMERGIUM_BAR,
    'RESOURCE_KEANIUM_BAR': RESOURCE_KEANIUM_BAR, 'RESOURCE_ZYNTHIUM_BAR': RESOURCE_ZYNTHIUM_BAR,
    'RESOURCE_PURIFIER': RESOURCE_PURIFIER, 'RESOURCE_GHODIUM_MELT': RESOURCE_GHODIUM_MELT,
    // Compounds (common)
    'RESOURCE_HYDROXIDE': RESOURCE_HYDROXIDE,
    'RESOURCE_ZYNTHIUM_KEANITE': RESOURCE_ZYNTHIUM_KEANITE,
    'RESOURCE_UTRIUM_LEMERGITE': RESOURCE_UTRIUM_LEMERGITE,
    // Commodities
    'RESOURCE_COMPOSITE': RESOURCE_COMPOSITE, 'RESOURCE_CRYSTAL': RESOURCE_CRYSTAL,
    'RESOURCE_LIQUID': RESOURCE_LIQUID,
    'RESOURCE_WIRE': RESOURCE_WIRE, 'RESOURCE_SWITCH': RESOURCE_SWITCH,
    'RESOURCE_TRANSISTOR': RESOURCE_TRANSISTOR, 'RESOURCE_MICROCHIP': RESOURCE_MICROCHIP,
    'RESOURCE_CIRCUIT': RESOURCE_CIRCUIT, 'RESOURCE_DEVICE': RESOURCE_DEVICE,
    'RESOURCE_CELL': RESOURCE_CELL, 'RESOURCE_PHLEGM': RESOURCE_PHLEGM,
    'RESOURCE_TISSUE': RESOURCE_TISSUE, 'RESOURCE_MUSCLE': RESOURCE_MUSCLE,
    'RESOURCE_ORGANOID': RESOURCE_ORGANOID, 'RESOURCE_ORGANISM': RESOURCE_ORGANISM,
    'RESOURCE_ALLOY': RESOURCE_ALLOY, 'RESOURCE_TUBE': RESOURCE_TUBE,
    'RESOURCE_FIXTURES': RESOURCE_FIXTURES, 'RESOURCE_FRAME': RESOURCE_FRAME,
    'RESOURCE_HYDRAULICS': RESOURCE_HYDRAULICS, 'RESOURCE_MACHINE': RESOURCE_MACHINE,
    'RESOURCE_CONDENSATE': RESOURCE_CONDENSATE, 'RESOURCE_CONCENTRATE': RESOURCE_CONCENTRATE,
    'RESOURCE_EXTRACT': RESOURCE_EXTRACT, 'RESOURCE_SPIRIT': RESOURCE_SPIRIT,
    'RESOURCE_EMANATION': RESOURCE_EMANATION, 'RESOURCE_ESSENCE': RESOURCE_ESSENCE,
    'RESOURCE_MIST': RESOURCE_MIST, 'RESOURCE_BIOMASS': RESOURCE_BIOMASS,
    'RESOURCE_METAL': RESOURCE_METAL, 'RESOURCE_SILICON': RESOURCE_SILICON,
};

/**
 * Resolve a material string — accepts constant names like 'RESOURCE_OXYGEN'
 * or actual values like 'O', plus 'NATIVE_RESOURCES'.
 */
function resolveMaterial(material) {
    if (RESOURCE_NAME_MAP[material]) return RESOURCE_NAME_MAP[material];
    return material;
}

/**
 * Expand a material query into an array of resource constants.
 *   - 'NATIVE_RESOURCES' → [mineral, bar] for that room
 *   - anything else       → [material]
 */
function expandMaterial(material, roomName) {
    if (material === 'NATIVE_RESOURCES') {
        const mineral = getRoomMineral(roomName);
        if (!mineral) return [];
        const bar = MINERAL_TO_BAR[mineral];
        return bar ? [mineral, bar] : [mineral];
    }
    return [resolveMaterial(material)];
}

/**
 * Get the actual amount of a resource in a building.
 */
function getActualAmount(roomName, material, building) {
    const room = Game.rooms[roomName];
    if (!room) return 0;

    let store = null;
    if (building === 'terminal') {
        store = room.terminal;
    } else if (building === 'storage') {
        store = room.storage;
    }
    if (!store) return 0;
    return store.store[material] || 0;
}

/**
 * Ensure the Memory path exists for a given room/building/material.
 */
function ensurePath(roomName, building, material) {
    if (!Memory.storageReservations) Memory.storageReservations = {};
    if (!Memory.storageReservations[roomName]) Memory.storageReservations[roomName] = {};
    if (!Memory.storageReservations[roomName][building]) Memory.storageReservations[roomName][building] = {};
    if (!Memory.storageReservations[roomName][building][material]) Memory.storageReservations[roomName][building][material] = [];
}

/**
 * Get all reservations for a room/building/material.
 */
function getReservations(roomName, building, material) {
    if (!Memory.storageReservations) return [];
    const r = Memory.storageReservations;
    if (!r[roomName] || !r[roomName][building] || !r[roomName][building][material]) return [];
    return r[roomName][building][material];
}

/**
 * Sum all reserved amounts for a room/building/material.
 */
function getTotalReserved(roomName, building, material) {
    const reservations = getReservations(roomName, building, material);
    let total = 0;
    for (let i = 0; i < reservations.length; i++) {
        total += reservations[i].amount;
    }
    return total;
}

/**
 * Find a program reservation entry.
 */
function findReservationIndex(roomName, building, material, program) {
    const reservations = getReservations(roomName, building, material);
    for (let i = 0; i < reservations.length; i++) {
        if (reservations[i].program === program) return i;
    }
    return -1;
}

// ─── PUBLIC API ──────────────────────────────────────────────────────

const storageManager = {

    /**
     * Reserve a quantity of material in a specific building for a program.
     *
     * If the same program already has a reservation for this slot, the amount
     * is REPLACED (not stacked). Call with a new amount to update.
     *
     * @param {string} roomName   - e.g. 'W1N1'
     * @param {string} material   - e.g. RESOURCE_OXYGEN
     * @param {string} building   - 'terminal' or 'storage'
     * @param {string} program    - e.g. 'factoryManager', 'marketSell'
     * @param {number} amount     - quantity to reserve
     * @returns {{ ok: boolean, reason?: string }}
     */
    reserve: function(roomName, material, building, program, amount) {
        if (!roomName || !material || !building || !program) {
            return { ok: false, reason: 'Missing required parameter' };
        }
        if (typeof amount !== 'number' || amount <= 0) {
            return { ok: false, reason: 'Amount must be a positive number' };
        }
        if (building !== 'terminal' && building !== 'storage') {
            return { ok: false, reason: 'Building must be "terminal" or "storage"' };
        }

        ensurePath(roomName, building, material);
        const reservations = Memory.storageReservations[roomName][building][material];

        // Check available space (actual minus already reserved by others)
        const actual = getActualAmount(roomName, material, building);
        let reservedByOthers = 0;
        let existingIndex = -1;

        for (let i = 0; i < reservations.length; i++) {
            if (reservations[i].program === program) {
                existingIndex = i;
            } else {
                reservedByOthers += reservations[i].amount;
            }
        }

        const available = actual - reservedByOthers;
        if (amount > available) {
            return {
                ok: false,
                reason: 'Insufficient available resources. Requested: ' + amount +
                        ', Available: ' + available + ' (actual: ' + actual +
                        ', reserved by others: ' + reservedByOthers + ')'
            };
        }

        // Update or create reservation
        if (existingIndex >= 0) {
            reservations[existingIndex].amount = amount;
            reservations[existingIndex].time = Game.time;
        } else {
            reservations.push({
                program: program,
                amount: amount,
                time: Game.time
            });
        }

        return { ok: true };
    },

    /**
     * Atomically hand off a reservation from one program to another.
     *
     * Source amount is decremented; destination amount is ADDED (not replaced).
     * This is deliberately different from reserve() which REPLACES — a handoff
     * should never erase an existing commitment, only grow it.
     *
     * If `amount` is omitted, the full current reservation of fromProgram is moved.
     * If fromProgram's reservation is smaller than `amount`, transfers what exists
     * and reports the partial in the response.
     *
     * Use case: labManager reserves reagents, then on broken-order liquidate
     * hands the reservation to marketSell so the resource can't be double-sold.
     *
     * @param {string} roomName
     * @param {string} material
     * @param {string} building   - 'terminal' or 'storage'
     * @param {string} fromProgram
     * @param {string} toProgram
     * @param {number} [amount]
     * @returns {{ ok: boolean, transferred?: number, fromRemaining?: number, toTotal?: number, reason?: string }}
     */
    transfer: function(roomName, material, building, fromProgram, toProgram, amount) {
        if (!roomName || !material || !building || !fromProgram || !toProgram) {
            return { ok: false, reason: 'Missing required parameter' };
        }
        if (building !== 'terminal' && building !== 'storage') {
            return { ok: false, reason: 'Building must be "terminal" or "storage"' };
        }
        if (fromProgram === toProgram) {
            return { ok: true, transferred: 0, fromRemaining: 0, toTotal: 0 };
        }

        const reservations = getReservations(roomName, building, material);
        let fromIdx = -1, toIdx = -1;
        for (let i = 0; i < reservations.length; i++) {
            if (reservations[i].program === fromProgram) fromIdx = i;
            else if (reservations[i].program === toProgram) toIdx = i;
        }

        if (fromIdx < 0) {
            return { ok: false, reason: 'No source reservation for ' + fromProgram };
        }

        const fromRes = reservations[fromIdx];
        const transferAmt = (typeof amount === 'number' && amount > 0)
            ? Math.min(amount, fromRes.amount)
            : fromRes.amount;

        if (transferAmt <= 0) {
            const existingToTotal = toIdx >= 0 ? reservations[toIdx].amount : 0;
            return {
                ok: true,
                transferred: 0,
                fromRemaining: fromRes.amount,
                toTotal: existingToTotal
            };
        }

        fromRes.amount -= transferAmt;
        fromRes.time = Game.time;

        if (toIdx >= 0) {
            reservations[toIdx].amount += transferAmt;
            reservations[toIdx].time = Game.time;
        } else {
            reservations.push({
                program: toProgram,
                amount: transferAmt,
                time: Game.time
            });
            toIdx = reservations.length - 1;
        }

        // Capture destination total BEFORE splicing the source. If fromIdx < toIdx
        // and the source is fully drained, the splice shifts the destination left,
        // so reservations[toIdx] would point at the wrong entry after cleanup.
        var toTotal = reservations[toIdx] ? reservations[toIdx].amount : transferAmt;

        // Clean up source if zero, mirror unReserve cascade
        if (fromRes.amount <= 0) {
            reservations.splice(fromIdx, 1);
            if (reservations.length === 0) {
                delete Memory.storageReservations[roomName][building][material];
                if (Object.keys(Memory.storageReservations[roomName][building]).length === 0) {
                    delete Memory.storageReservations[roomName][building];
                    if (Object.keys(Memory.storageReservations[roomName]).length === 0) {
                        delete Memory.storageReservations[roomName];
                    }
                }
            }
        }

        return {
            ok: true,
            transferred: transferAmt,
            fromRemaining: fromRes.amount,
            toTotal: toTotal
        };
    },

    /**
     * Remove a program's reservation for a material in a building.
     *
     * @param {string} roomName
     * @param {string} material
     * @param {string} building   - 'terminal' or 'storage'
     * @param {string} program
     * @returns {{ ok: boolean, removed: number }}
     */
    unReserve: function(roomName, material, building, program) {
        if (!Memory.storageReservations) return { ok: false, removed: 0 };
        const r = Memory.storageReservations;
        if (!r[roomName] || !r[roomName][building] || !r[roomName][building][material]) {
            return { ok: false, removed: 0 };
        }

        const reservations = r[roomName][building][material];
        let removed = 0;
        for (let i = reservations.length - 1; i >= 0; i--) {
            if (reservations[i].program === program) {
                removed = reservations[i].amount;
                reservations.splice(i, 1);
            }
        }

        // Clean up empty arrays/objects to save Memory size
        if (reservations.length === 0) {
            delete r[roomName][building][material];
            if (Object.keys(r[roomName][building]).length === 0) {
                delete r[roomName][building];
                if (Object.keys(r[roomName]).length === 0) {
                    delete r[roomName];
                }
            }
        }

        return { ok: removed > 0, removed: removed };
    },

    /**
     * Consume part of a reservation as the resource is physically used.
     *
     * This is the missing bridge between intent and actual movement.
     * @returns {{ ok: boolean, consumed: number, remaining: number, reason?: string }}
     */
    consume: function(roomName, material, building, program, amount) {
        if (!Memory.storageReservations) {
            return { ok: false, consumed: 0, remaining: 0, reason: 'No reservations' };
        }
        if (!roomName || !material || !building || !program) {
            return { ok: false, consumed: 0, remaining: 0, reason: 'Missing required parameter' };
        }
        if (typeof amount !== 'number' || amount <= 0) {
            return { ok: false, consumed: 0, remaining: 0, reason: 'Amount must be a positive number' };
        }

        const r = Memory.storageReservations;
        if (!r[roomName] || !r[roomName][building] || !r[roomName][building][material]) {
            return { ok: false, consumed: 0, remaining: 0, reason: 'No matching reservation bucket' };
        }

        const reservations = r[roomName][building][material];
        const idx = findReservationIndex(roomName, building, material, program);
        if (idx < 0) {
            return { ok: false, consumed: 0, remaining: 0, reason: 'No matching reservation for program' };
        }

        const entry = reservations[idx];
        const consumed = Math.min(amount, entry.amount);
        entry.amount -= consumed;
        entry.time = Game.time;

        if (entry.amount <= 0) {
            reservations.splice(idx, 1);
            if (reservations.length === 0) {
                delete r[roomName][building][material];
                if (Object.keys(r[roomName][building]).length === 0) {
                    delete r[roomName][building];
                    if (Object.keys(r[roomName]).length === 0) {
                        delete r[roomName];
                    }
                }
            }
            return { ok: true, consumed: consumed, remaining: 0 };
        }

        return { ok: true, consumed: consumed, remaining: entry.amount };
    },

    /**
     * Query inventory with reservation breakdown.
     *
     * @param {string} roomName   - specific room or 'all'
     * @param {string} material   - resource constant or 'NATIVE_RESOURCES'
     * @returns {Object} — shape depends on query:
     *
     *   Single room + single material:
     *     { terminal: { total, reserved, available, reservations: [...] },
     *       storage:  { total, reserved, available, reservations: [...] },
     *       combined: { total, reserved, available } }
     *
     *   Single room + NATIVE_RESOURCES:
     *     { 'O': { terminal: {...}, storage: {...}, combined: {...} },
     *       'oxidant': { terminal: {...}, storage: {...}, combined: {...} } }
     *
     *   'all' rooms:
     *     { 'W1N1': <same as single-room shape>, 'W2N2': {...}, ... ,
     *       totals: { total, reserved, available } }
     */
    storageFind: function(roomName, material) {
        if (roomName === 'all') {
            return this._findAll(material);
        }
        return this._findRoom(roomName, material);
    },

    // ── Internal: single room query ──

    _findRoom: function(roomName, material) {
        const materials = expandMaterial(material, roomName);
        if (materials.length === 0) {
            return { error: 'Could not resolve materials for ' + roomName };
        }

        // Single material → flat result
        if (materials.length === 1 && material !== 'NATIVE_RESOURCES') {
            return this._buildingBreakdown(roomName, materials[0]);
        }

        // Multiple materials (NATIVE_RESOURCES) → keyed by resource
        const result = {};
        for (let i = 0; i < materials.length; i++) {
            result[materials[i]] = this._buildingBreakdown(roomName, materials[i]);
        }
        return result;
    },

    _buildingBreakdown: function(roomName, material) {
        const termReservations = getReservations(roomName, 'terminal', material);
        const storReservations = getReservations(roomName, 'storage', material);

        const termTotal = getActualAmount(roomName, material, 'terminal');
        const storTotal = getActualAmount(roomName, material, 'storage');

        const termReserved = getTotalReserved(roomName, 'terminal', material);
        const storReserved = getTotalReserved(roomName, 'storage', material);

        return {
            terminal: {
                total: termTotal,
                reserved: termReserved,
                available: termTotal - termReserved,
                reservations: termReservations
            },
            storage: {
                total: storTotal,
                reserved: storReserved,
                available: storTotal - storReserved,
                reservations: storReservations
            },
            combined: {
                total: termTotal + storTotal,
                reserved: termReserved + storReserved,
                available: (termTotal - termReserved) + (storTotal - storReserved)
            }
        };
    },

    // ── Internal: all-rooms query ──

    _findAll: function(material) {
        const result = {};
        let grandTotal = 0, grandReserved = 0;

        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            if (!room.controller || !room.controller.my) continue;

            const roomResult = this._findRoom(roomName, material);
            result[roomName] = roomResult;

            // Accumulate totals
            if (roomResult.combined) {
                grandTotal += roomResult.combined.total;
                grandReserved += roomResult.combined.reserved;
            } else {
                // NATIVE_RESOURCES — multiple sub-keys
                for (const res in roomResult) {
                    if (roomResult[res].combined) {
                        grandTotal += roomResult[res].combined.total;
                        grandReserved += roomResult[res].combined.reserved;
                    }
                }
            }
        }

        result.totals = {
            total: grandTotal,
            reserved: grandReserved,
            available: grandTotal - grandReserved
        };

        return result;
    },

    /**
     * Return all currently unreserved materials in a room, split by building.
     *
     * Shape:
     *   {
     *     terminal: { RESOURCE_X: available, ... },
     *     storage:  { RESOURCE_Y: available, ... }
     *   }
     *
     * This reflects live reservation state, so resources committed to marketSell
     * should be excluded from both terminal and storage once syncReservations has
     * updated Memory.storageReservations.
     *
     * Only resources with a positive unreserved amount are included.
     *
     * Usage from console: getUnreserved('E0N0')
     *
     * @param {string} roomName
     * @returns {{terminal: Object<string, number>, storage: Object<string, number>}}
     */
    getUnreserved: function(roomName) {
        const room = Game.rooms[roomName];
        const result = {
            terminal: {},
            storage: {}
        };

        if (!room) return result;

        const scanBuilding = function(building, store) {
            if (!store || !store.store) return;

            for (const material in store.store) {
                const total = store.store[material] || 0;
                if (total <= 0) continue;

                const reserved = getTotalReserved(roomName, building, material);
                const available = total - reserved;
                if (available > 0) {
                    result[building][material] = available;
                }
            }
        };

        scanBuilding('terminal', room.terminal);
        scanBuilding('storage', room.storage);

        return result;
    },

    /**
     * Pretty-print unreserved inventory for console use.
     *
     * Usage from console: getUnreserved('E0N0')
     *
     * @param {string} roomName
     */
    printUnreserved: function(roomName) {
        const data = this.getUnreserved(roomName);
        const padRight = function(str, len) {
            str = String(str);
            while (str.length < len) str = str + ' ';
            return str;
        };
        const fmt = function(n) {
            return (n.toLocaleString ? n.toLocaleString() : String(n));
        };

        const printSection = function(title, store) {
            const keys = Object.keys(store).sort();
            console.log(title + ':');
            if (keys.length === 0) {
                console.log('  none');
                return;
            }
            for (let i = 0; i < keys.length; i++) {
                const material = keys[i];
                console.log('  ' + padRight(material, 24) + fmt(store[material]));
            }
        };

        console.log('═══ ' + roomName + ' Unreserved ═══');
        printSection('terminal', data.terminal);
        printSection('storage', data.storage);
    },

    // ── Utility: list all reservations (console debugging) ──

    /**
     * Print all active reservations to console as one contiguous block.
     * Call from console: storageManager.listReservations()
     */
    listReservations: function(filterRoom, filterProgram) {
        if (!Memory.storageReservations) {
            console.log('[StorageManager] No reservations.');
            return;
        }
        const r = Memory.storageReservations;
        const rows = [];
        let count = 0;

        for (const roomName in r) {
            if (filterRoom && roomName !== filterRoom) continue;
            for (const building in r[roomName]) {
                for (const material in r[roomName][building]) {
                    const reservations = r[roomName][building][material];
                    for (let i = 0; i < reservations.length; i++) {
                        const res = reservations[i];
                        if (filterProgram && res.program !== filterProgram) continue;
                        rows.push({
                            roomName: roomName,
                            building: building,
                            material: material,
                            program: res.program,
                            amount: res.amount,
                            time: res.time
                        });
                        count++;
                    }
                }
            }
        }

        const lines = [];
        const roomLabel = filterRoom ? filterRoom : '*';
        const programLabel = filterProgram ? filterProgram : '*';
        lines.push('[StorageManager] Reservations room=' + roomLabel + ' program=' + programLabel);

        if (rows.length === 0) {
            lines.push('  none');
            lines.push('Total reservations: 0');
            console.log(lines.join('\n'));
            return;
        }

        rows.sort(function(a, b) {
            if (a.roomName !== b.roomName) return a.roomName < b.roomName ? -1 : 1;
            if (a.building !== b.building) return a.building < b.building ? -1 : 1;
            if (a.material !== b.material) return a.material < b.material ? -1 : 1;
            if (a.program !== b.program) return a.program < b.program ? -1 : 1;
            return (a.time || 0) - (b.time || 0);
        });

        function padRight(str, len) {
            str = String(str);
            while (str.length < len) str += ' ';
            return str;
        }

        lines.push('room        building  material                program       amount   tick       age');
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const age = (typeof row.time === 'number' && typeof Game.time === 'number') ? (Game.time - row.time) : '-';
            lines.push(
                padRight(row.roomName, 11) + ' ' +
                padRight(row.building, 9) + ' ' +
                padRight(row.material, 23) + ' ' +
                padRight(row.program, 12) + ' ' +
                padRight(row.amount, 8) + ' ' +
                padRight(row.time, 10) + ' ' +
                age
            );
        }

        lines.push('Total reservations: ' + count);
        console.log(lines.join('\n'));
    },

    /**
     * Validate reservation state against live room inventory.
     * Returns a list of warnings and also logs them to console.
     *
     * @param {string} [filterRoom]
     * @returns {Array<string>}
     */
    validateReservations: function(filterRoom) {
        var warnings = [];
        if (!Memory.storageReservations) return warnings;

        var addWarn = function(msg) {
            warnings.push(msg);
            console.log('[StorageManager] ' + msg);
        };

        for (var roomName in Memory.storageReservations) {
            if (filterRoom && roomName !== filterRoom) continue;
            var roomBuckets = Memory.storageReservations[roomName];
            for (var building in roomBuckets) {
                for (var material in roomBuckets[building]) {
                    var reservations = roomBuckets[building][material] || [];
                    var actual = getActualAmount(roomName, material, building);
                    var reserved = 0;
                    var seenPrograms = {};
                    for (var i = 0; i < reservations.length; i++) {
                        var resv = reservations[i];
                        if (!resv) continue;
                        reserved += resv.amount || 0;
                        if (seenPrograms[resv.program]) {
                            addWarn(roomName + ' | ' + building + ' | ' + material + ' has duplicate reservation program ' + resv.program);
                        }
                        seenPrograms[resv.program] = true;
                    }
                    if (reserved > actual) {
                        addWarn(roomName + ' | ' + building + ' | ' + material + ' reserved ' + reserved + ' > actual ' + actual);
                    }
                }
            }
        }

        if (warnings.length === 0) {
            console.log('[StorageManager] Reservation validation passed.');
        }
        return warnings;
    },

    /**
     * Purge stale reservations older than maxAge ticks.
     * Useful as a periodic cleanup in the main loop.
     * Default raised to 20000 to cover labManager's BROKEN_ORDER_TICKS (10000)
     * with margin and prevent legitimate long-running factory orders from
     * being purged mid-flight. Leaked reservations are still caught within
     * ~5.5 hours of real time.
     * @param {number} [maxAge=20000]
     */
    cleanStale: function(maxAge) {
        if (maxAge === undefined) maxAge = 20000;
        if (!Memory.storageReservations) return;
        const r = Memory.storageReservations;
        let cleaned = 0;

        for (const roomName in r) {
            for (const building in r[roomName]) {
                for (const material in r[roomName][building]) {
                    const reservations = r[roomName][building][material];
                    for (let i = reservations.length - 1; i >= 0; i--) {
                        if (Game.time - reservations[i].time > maxAge) {
                            console.log(
                                '[StorageManager] Purging stale reservation: ' +
                                roomName + '/' + building + '/' + material +
                                ' by ' + reservations[i].program +
                                ' (age: ' + (Game.time - reservations[i].time) + ')'
                            );
                            reservations.splice(i, 1);
                            cleaned++;
                        }
                    }
                    // Clean up empty
                    if (reservations.length === 0) delete r[roomName][building][material];
                }
                if (Object.keys(r[roomName][building]).length === 0) delete r[roomName][building];
            }
            if (Object.keys(r[roomName]).length === 0) delete r[roomName];
        }

        if (cleaned > 0) {
            console.log('[StorageManager] Cleaned ' + cleaned + ' stale reservations.');
        }
    },

    // ── Compact console printer ──

    /**
     * Pretty-print storageFind results to console in compact format.
     * Usage from console: storageFind('all', 'NATIVE_RESOURCES')
     *                     storageFind('E2N46', RESOURCE_OXYGEN)
     */
    printFind: function(roomName, material) {
        var resolved = resolveMaterial(material);
        var data = this.storageFind(roomName, material);
        if (data.error) { console.log('[StorageManager] ' + data.error); return; }

        var pad = function(str, len) {
            str = String(str);
            while (str.length < len) str = ' ' + str;
            return str;
        };
        var fmt = function(n) {
            return pad(n.toLocaleString ? n.toLocaleString() : String(n), 9);
        };
        var rpad = function(str, len) {
            str = String(str);
            while (str.length < len) str = str + ' ';
            return str;
        };

        // Short display names for bars
        var SHORT = {
            reductant: 'H_bar', oxidant: 'O_bar',
            utrium_bar: 'U_bar', lemergium_bar: 'L_bar',
            keanium_bar: 'K_bar', zynthium_bar: 'Z_bar',
            purifier: 'X_bar'
        };
        var shortName = function(s) { return SHORT[s] || s; };

        var printRow = function(res, info) {
            var c = info.combined;
            var tag = c.reserved > 0 ? (' (rsv:' + c.reserved + ')') : '';
            return rpad(shortName(res) + ':', 8) + fmt(c.available) + tag;
        };

        // 'all' query — has .totals
        if (data.totals) {
            console.log('═══ Storage Inventory ═══');
            for (var rm in data) {
                if (rm === 'totals') continue;
                var entry = data[rm];
                var parts = [];
                // NATIVE_RESOURCES returns keyed by resource, single material returns .combined directly
                if (entry.combined) {
                    parts.push(printRow(resolved, entry));
                } else {
                    for (var res in entry) {
                        if (entry[res].combined) parts.push(printRow(res, entry[res]));
                    }
                }
                if (parts.length > 0) {
                    // Skip rooms with all zeros
                    var hasAny = false;
                    for (var res2 in entry) {
                        var c2 = entry[res2].combined || entry[res2];
                        if ((c2.total || 0) > 0) { hasAny = true; break; }
                    }
                    if (entry.combined && entry.combined.total > 0) hasAny = true;
                    if (hasAny) {
                        console.log(rpad(rm, 10) + '  ' + parts.join('  |  '));
                    }
                }
            }
            var t = data.totals;
            var rsvTag = t.reserved > 0 ? ' (reserved: ' + t.reserved + ')' : '';
            console.log('─── Total: ' + fmt(t.available).trim() + rsvTag + ' ───');
        } else if (data.combined) {
            // Single room + single material
            var c = data.combined;
            console.log(roomName + '  ' + resolved + ':  total=' + c.total +
                '  reserved=' + c.reserved + '  available=' + c.available);
            if (data.terminal.reservations.length > 0 || data.storage.reservations.length > 0) {
                var allRes = data.terminal.reservations.concat(data.storage.reservations);
                for (var i = 0; i < allRes.length; i++) {
                    var r = allRes[i];
                    console.log('  └─ ' + r.program + ': ' + r.amount);
                }
            }
        } else {
            // Single room + NATIVE_RESOURCES
            console.log('═══ ' + roomName + ' Native Resources ═══');
            for (var res3 in data) {
                if (data[res3].combined) {
                    console.log('  ' + printRow(res3, data[res3]));
                }
            }
        }
    },

    // ── Expose constants for external use ──
    MINERAL_TO_BAR: MINERAL_TO_BAR,
    BAR_TO_MINERAL: BAR_TO_MINERAL
};

module.exports = storageManager;
