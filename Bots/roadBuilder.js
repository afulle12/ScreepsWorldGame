// roadBuilder.js
// Usage: require this module in main.js and it registers a global function.
//
// In main.js add:
//   const roadBuilder = require('roadBuilder');
//   global.buildRoad  = roadBuilder.buildRoad;
//   global.removeRoad = roadBuilder.removeRoad;
//
// Then call from the Screeps console:
//   buildRoad('E2N46', 8, 36, 42, 2)
//   buildRoad('E2N46', 8, 36, 42, 2, { plainCost: 2, swampCost: 10 })  // optional overrides
//   removeRoad('E2N46', 8, 36, 42, 2)
//   removeRoad('E2N46', 8, 36, 42, 2, { plainCost: 2, swampCost: 10 }) // optional overrides

'use strict';

/**
 * Build a shared CostMatrix for a room, used by both buildRoad and removeRoad.
 * Existing roads are cheap (1); blocking structures are impassable (255).
 */
function _roomCostMatrix(name) {
    var r = Game.rooms[name];
    if (!r) return;
    var costs = new PathFinder.CostMatrix();

    r.find(FIND_STRUCTURES).forEach(function(s) {
        if (s.structureType === STRUCTURE_ROAD) {
            costs.set(s.pos.x, s.pos.y, 1);
        } else if (s.structureType !== STRUCTURE_CONTAINER &&
                   s.structureType !== STRUCTURE_RAMPART) {
            costs.set(s.pos.x, s.pos.y, 255);
        }
    });

    r.find(FIND_CONSTRUCTION_SITES).forEach(function(s) {
        if (s.structureType !== STRUCTURE_ROAD &&
            s.structureType !== STRUCTURE_CONTAINER &&
            s.structureType !== STRUCTURE_RAMPART) {
            costs.set(s.pos.x, s.pos.y, 255);
        }
    });

    return costs;
}

/**
 * Find a PathFinder path between two points in the same room.
 * Returns the path result, or null if the room is not visible.
 */
function _findPath(roomName, fromX, fromY, toX, toY, opts) {
    var from = new RoomPosition(fromX, fromY, roomName);
    var to   = new RoomPosition(toX,   toY,   roomName);

    return PathFinder.search(from, { pos: to, range: opts.range || 0 }, {
        plainCost: opts.plainCost || 1,
        swampCost: opts.swampCost || 1,
        roomCallback: _roomCostMatrix
    });
}

// ---------------------------------------------------------------------------

/**
 * Place road construction sites along the PathFinder path between two points.
 *
 * @param {string} roomName   - The room name, e.g. 'E2N46'
 * @param {number} fromX      - Start X coordinate
 * @param {number} fromY      - Start Y coordinate
 * @param {number} toX        - Destination X coordinate
 * @param {number} toY        - Destination Y coordinate
 * @param {object} [opts]     - Optional overrides: { plainCost, swampCost, range }
 */
function buildRoad(roomName, fromX, fromY, toX, toY, opts) {
    opts = opts || {};

    var room = Game.rooms[roomName];
    if (!room) {
        console.log('[buildRoad] ERROR: No vision in room ' + roomName + '. A creep or structure must be present there.');
        return;
    }

    console.log('[buildRoad] Searching path from (' + fromX + ',' + fromY + ') to (' + toX + ',' + toY + ') in ' + roomName + '...');

    var path = _findPath(roomName, fromX, fromY, toX, toY, opts);

    if (!path || path.path.length === 0) {
        console.log('[buildRoad] ERROR: No path found. incomplete=' + path.incomplete);
        return;
    }

    console.log('[buildRoad] Path found: ' + path.path.length + ' steps, cost=' + path.cost + ', incomplete=' + path.incomplete);

    var placed  = 0;
    var skipped = 0;
    var errors  = [];

    for (var i = 0; i < path.path.length; i++) {
        var pos = path.path[i];

        var hasRoad = pos.lookFor(LOOK_STRUCTURES).some(function(s) {
            return s.structureType === STRUCTURE_ROAD;
        });
        var hasSite = pos.lookFor(LOOK_CONSTRUCTION_SITES).some(function(s) {
            return s.structureType === STRUCTURE_ROAD;
        });

        if (hasRoad || hasSite) {
            skipped++;
            continue;
        }

        var code = room.createConstructionSite(pos.x, pos.y, STRUCTURE_ROAD);
        if (code === OK) {
            placed++;
        } else {
            var reason = _errorCode(code);
            errors.push('(' + pos.x + ',' + pos.y + ') code=' + code + ' (' + reason + ')');
            // ERR_FULL (-8) means 100 site cap hit — no point continuing
            if (code === ERR_FULL) {
                console.log('[buildRoad] Hit 100 construction site cap at step ' + i + '. Stopping early.');
                break;
            }
        }
    }

    console.log('[buildRoad] Done. Placed=' + placed + ' Skipped=' + skipped + ' Errors=' + errors.length);
    if (errors.length > 0) {
        console.log('[buildRoad] Error details: ' + errors.join(' | '));
    }
}

// ---------------------------------------------------------------------------

/**
 * Remove roads and road construction sites along the PathFinder path between two points.
 *
 * @param {string} roomName   - The room name, e.g. 'E2N46'
 * @param {number} fromX      - Start X coordinate
 * @param {number} fromY      - Start Y coordinate
 * @param {number} toX        - Destination X coordinate
 * @param {number} toY        - Destination Y coordinate
 * @param {object} [opts]     - Optional overrides: { plainCost, swampCost, range }
 */
function removeRoad(roomName, fromX, fromY, toX, toY, opts) {
    opts = opts || {};

    var room = Game.rooms[roomName];
    if (!room) {
        console.log('[removeRoad] ERROR: No vision in room ' + roomName + '. A creep or structure must be present there.');
        return;
    }

    console.log('[removeRoad] Searching path from (' + fromX + ',' + fromY + ') to (' + toX + ',' + toY + ') in ' + roomName + '...');

    var path = _findPath(roomName, fromX, fromY, toX, toY, opts);

    if (!path || path.path.length === 0) {
        console.log('[removeRoad] ERROR: No path found. incomplete=' + path.incomplete);
        return;
    }

    console.log('[removeRoad] Path found: ' + path.path.length + ' steps, cost=' + path.cost + ', incomplete=' + path.incomplete);

    var demolished = 0;
    var cancelled  = 0;
    var skipped    = 0;
    var errors     = [];

    for (var i = 0; i < path.path.length; i++) {
        var pos = path.path[i];

        // Destroy built roads
        var roads = pos.lookFor(LOOK_STRUCTURES).filter(function(s) {
            return s.structureType === STRUCTURE_ROAD;
        });
        roads.forEach(function(road) {
            var code = road.destroy();
            if (code === OK) {
                demolished++;
            } else {
                errors.push('destroy (' + pos.x + ',' + pos.y + ') code=' + code + ' (' + _errorCode(code) + ')');
            }
        });

        // Cancel road construction sites
        var sites = pos.lookFor(LOOK_CONSTRUCTION_SITES).filter(function(s) {
            return s.structureType === STRUCTURE_ROAD;
        });
        sites.forEach(function(site) {
            var code = site.remove();
            if (code === OK) {
                cancelled++;
            } else {
                errors.push('remove site (' + pos.x + ',' + pos.y + ') code=' + code + ' (' + _errorCode(code) + ')');
            }
        });

        if (roads.length === 0 && sites.length === 0) {
            skipped++;
        }
    }

    console.log('[removeRoad] Done. Demolished=' + demolished + ' Cancelled=' + cancelled + ' Skipped=' + skipped + ' Errors=' + errors.length);
    if (errors.length > 0) {
        console.log('[removeRoad] Error details: ' + errors.join(' | '));
    }
}

// ---------------------------------------------------------------------------

function _errorCode(code) {
    var map = {
        '0':   'OK',
        '-1':  'ERR_NOT_OWNER',
        '-7':  'ERR_INVALID_TARGET',
        '-8':  'ERR_FULL',
        '-10': 'ERR_INVALID_ARGS',
        '-14': 'ERR_RCL_NOT_ENOUGH',
    };
    return map[String(code)] || 'UNKNOWN';
}

module.exports = { buildRoad: buildRoad, removeRoad: removeRoad };