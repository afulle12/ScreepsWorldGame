// singleSourceRoom.js
// ============================================================================
// Utility for 1-source RCL 8 rooms: detection, anchor tile computation,
// link chain identification, and spawn helpers.
//
// Console commands:
//   detectAnchors('W1N1')     — auto-detect and store anchor tiles
//   setAnchor('W1N1', 'hd', 25, 30)  — manually set an anchor tile
//   showAnchors('W1N1')       — display current anchor config
//   enableSingleSource('W1N1') — mark room for single-source mode
//   disableSingleSource('W1N1') — revert to normal mode
//
// Anchor data is stored under Memory.anchors[roomName] (NOT Memory.rooms)
// to prevent it being wiped by getRoomState or any other Memory.rooms writer.
//
// ============================================================================

var getRoomState = require('getRoomState');

// Direction map for spawn directions
var DIR_OFFSETS = {};
DIR_OFFSETS[TOP]          = { dx:  0, dy: -1 };
DIR_OFFSETS[TOP_RIGHT]    = { dx:  1, dy: -1 };
DIR_OFFSETS[RIGHT]        = { dx:  1, dy:  0 };
DIR_OFFSETS[BOTTOM_RIGHT] = { dx:  1, dy:  1 };
DIR_OFFSETS[BOTTOM]       = { dx:  0, dy:  1 };
DIR_OFFSETS[BOTTOM_LEFT]  = { dx: -1, dy:  1 };
DIR_OFFSETS[LEFT]         = { dx: -1, dy:  0 };
DIR_OFFSETS[TOP_LEFT]     = { dx: -1, dy: -1 };

var REVERSE_DIR = {};
REVERSE_DIR['0,-1']  = TOP;
REVERSE_DIR['1,-1']  = TOP_RIGHT;
REVERSE_DIR['1,0']   = RIGHT;
REVERSE_DIR['1,1']   = BOTTOM_RIGHT;
REVERSE_DIR['0,1']   = BOTTOM;
REVERSE_DIR['-1,1']  = BOTTOM_LEFT;
REVERSE_DIR['-1,0']  = LEFT;
REVERSE_DIR['-1,-1'] = TOP_LEFT;

// ============================================================================
// Memory helpers — isolated namespace so Memory.rooms resets can't nuke anchors
// ============================================================================

function getAnchorMemory(roomName) {
    if (!Memory.anchors) return null;
    return Memory.anchors[roomName] || null;
}

function setAnchorMemory(roomName, data) {
    if (!Memory.anchors) Memory.anchors = {};
    Memory.anchors[roomName] = data;
}

// ============================================================================
// Detection
// ============================================================================

function isSingleSourceRoom(roomName) {
    if (!Memory.singleSourceRooms) return false;
    return !!Memory.singleSourceRooms[roomName];
}

function isSingleSourceActive(roomName) {
    if (!isSingleSourceRoom(roomName)) return false;
    var room = Game.rooms[roomName];
    if (!room || !room.controller || !room.controller.my) return false;
    if (room.controller.level < 8) return false;
    var rs = getRoomState.get(roomName);
    if (!rs || !rs.sources || rs.sources.length !== 1) return false;
    return true;
}

// ============================================================================
// Anchor Tile Computation
// ============================================================================

/**
 * Get 8 adjacent tiles around a position (excludes edges 0/49).
 */
function getAdjacentTiles(pos) {
    var tiles = [];
    for (var dx = -1; dx <= 1; dx++) {
        for (var dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            var x = pos.x + dx;
            var y = pos.y + dy;
            if (x < 1 || x > 48 || y < 1 || y > 48) continue;
            tiles.push({ x: x, y: y });
        }
    }
    return tiles;
}

/**
 * Check if a tile is walkable (not a wall, not an obstacle structure).
 */
function isWalkable(room, x, y) {
    var terrain = room.getTerrain();
    if (terrain.get(x, y) === TERRAIN_MASK_WALL) return false;

    var structs = room.lookForAt(LOOK_STRUCTURES, x, y);
    for (var i = 0; i < structs.length; i++) {
        var st = structs[i].structureType;
        if (st === STRUCTURE_ROAD || st === STRUCTURE_CONTAINER || st === STRUCTURE_RAMPART) continue;
        if (OBSTACLE_OBJECT_TYPES.indexOf(st) !== -1) return false;
    }
    return true;
}

/**
 * Check if position is within range 1 of a target position.
 */
function inRange1(tileX, tileY, target) {
    return Math.abs(tileX - target.x) <= 1 && Math.abs(tileY - target.y) <= 1;
}

/**
 * Count structures of a type within range 1 of a tile.
 */
function countAdjacent(tileX, tileY, structures) {
    var count = 0;
    for (var i = 0; i < structures.length; i++) {
        if (inRange1(tileX, tileY, structures[i].pos)) count++;
    }
    return count;
}

/**
 * Find a tile that is adjacent (range 1) to ALL required structures
 * and preferably adjacent to as many optional structures as possible.
 *
 * @param {Room} room
 * @param {Array} required - Array of game objects or {pos} objects. Tile must be range 1 to all.
 * @param {Array} optional - Array of game objects. More adjacency = better score.
 * @returns {{ x: number, y: number }|null}
 */
function findAnchorTile(room, required, optional) {
    if (!required || required.length === 0) return null;

    // Start with tiles adjacent to first required structure
    var firstPos = required[0].pos || required[0];
    var candidates = getAdjacentTiles(firstPos);

    // Intersect with each additional required structure
    for (var r = 1; r < required.length; r++) {
        var reqPos = required[r].pos || required[r];
        candidates = candidates.filter(function(tile) {
            return inRange1(tile.x, tile.y, reqPos);
        });
    }

    // Filter out non-walkable tiles
    candidates = candidates.filter(function(tile) {
        return isWalkable(room, tile.x, tile.y);
    });

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    // Score by number of optional structures adjacent
    var best = candidates[0];
    var bestScore = 0;

    for (var c = 0; c < candidates.length; c++) {
        var tile = candidates[c];
        var score = 0;
        if (optional) {
            for (var o = 0; o < optional.length; o++) {
                var optPos = optional[o].pos || optional[o];
                if (inRange1(tile.x, tile.y, optPos)) score++;
            }
        }
        if (score > bestScore) {
            bestScore = score;
            best = tile;
        }
    }

    return best;
}

/**
 * Classify links for a 1-source room.
 * Returns { source: id, factory: id, tower: id, controller: id }
 */
function classifyLinks(roomName) {
    var rs = getRoomState.get(roomName);
    if (!rs) return null;

    var room = Game.rooms[roomName];
    if (!room) return null;

    var byType = rs.structuresByType || {};
    var links = byType[STRUCTURE_LINK] || [];
    var sources = rs.sources || [];
    var towers = byType[STRUCTURE_TOWER] || [];
    var factory = (byType[STRUCTURE_FACTORY] && byType[STRUCTURE_FACTORY].length > 0) ? byType[STRUCTURE_FACTORY][0] : null;
    var terminal = (byType[STRUCTURE_TERMINAL] && byType[STRUCTURE_TERMINAL].length > 0) ? byType[STRUCTURE_TERMINAL][0] : null;
    var controller = rs.controller;

    var result = { source: null, factory: null, tower: null, controller: null };
    var assigned = {};

    // 1. Source link: range 2 of source
    for (var i = 0; i < links.length; i++) {
        var link = links[i];
        if (assigned[link.id]) continue;
        for (var s = 0; s < sources.length; s++) {
            if (link.pos.getRangeTo(sources[s]) <= 2) {
                result.source = link.id;
                assigned[link.id] = true;
                break;
            }
        }
        if (result.source) break;
    }

    // 2. Controller link: range 2 of controller
    for (var i = 0; i < links.length; i++) {
        var link = links[i];
        if (assigned[link.id]) continue;
        if (controller && link.pos.getRangeTo(controller) <= 3) {
            result.controller = link.id;
            assigned[link.id] = true;
            break;
        }
    }

    // 3. Factory link: range 2 of factory or terminal
    for (var i = 0; i < links.length; i++) {
        var link = links[i];
        if (assigned[link.id]) continue;
        var nearFactory = factory && link.pos.getRangeTo(factory) <= 2;
        var nearTerminal = terminal && link.pos.getRangeTo(terminal) <= 2;
        if (nearFactory || nearTerminal) {
            result.factory = link.id;
            assigned[link.id] = true;
            break;
        }
    }

    // 4. Tower link: range 2 of any tower (whatever is left)
    for (var i = 0; i < links.length; i++) {
        var link = links[i];
        if (assigned[link.id]) continue;
        for (var t = 0; t < towers.length; t++) {
            if (link.pos.getRangeTo(towers[t]) <= 2) {
                result.tower = link.id;
                assigned[link.id] = true;
                break;
            }
        }
        if (result.tower) break;
    }

    return result;
}

/**
 * Auto-detect anchor positions for all 3 stationary roles.
 * Stores in Memory.anchors[roomName]  (isolated from Memory.rooms)
 */
function detectAnchors(roomName) {
    var room = Game.rooms[roomName];
    if (!room) return '[SingleSource] Room not visible: ' + roomName;

    var rs = getRoomState.get(roomName);
    if (!rs) return '[SingleSource] No room state for: ' + roomName;

    var byType = rs.structuresByType || {};
    var sources = rs.sources || [];
    var spawns = (byType[STRUCTURE_SPAWN] || []).filter(function(s) { return s.my; });
    var links = (byType[STRUCTURE_LINK] || []).filter(function(s) { return s.my; });
    var extensions = (byType[STRUCTURE_EXTENSION] || []).filter(function(s) { return s.my; });
    var towers = (byType[STRUCTURE_TOWER] || []).filter(function(s) { return s.my; });
    var factories = byType[STRUCTURE_FACTORY] || [];
    var terminals = byType[STRUCTURE_TERMINAL] || [];
    var extractors = (byType[STRUCTURE_EXTRACTOR] || []).filter(function(s) { return s.my; });
    var minerals = rs.minerals || [];
    var storage = rs.storage;

    if (sources.length !== 1) return '[SingleSource] Room has ' + sources.length + ' sources, expected 1.';

    // Classify links
    var linkClass = classifyLinks(roomName);
    if (!linkClass) return '[SingleSource] Could not classify links.';

    var sourceLink = linkClass.source ? Game.getObjectById(linkClass.source) : null;
    var factoryLink = linkClass.factory ? Game.getObjectById(linkClass.factory) : null;
    var towerLink = linkClass.tower ? Game.getObjectById(linkClass.tower) : null;
    var controllerLink = linkClass.controller ? Game.getObjectById(linkClass.controller) : null;

    var results = [];

    // --- HD Anchor: adjacent to source + spawn + sourceLink ---
    var hdAnchor = null;
    if (sources[0] && sourceLink) {
        var sourceSpawns = spawns.filter(function(sp) {
            return sp.pos.getRangeTo(sources[0]) <= 2;
        });
        if (sourceSpawns.length > 0) {
            var hdRequired = [sources[0], sourceSpawns[0], sourceLink];
            hdAnchor = findAnchorTile(room, hdRequired, extensions);
            if (hdAnchor) {
                results.push('HD anchor: (' + hdAnchor.x + ',' + hdAnchor.y + ') near source');
            } else {
                results.push('HD anchor: FAILED - no valid tile adjacent to source + spawn + link');
            }
        } else {
            results.push('HD anchor: FAILED - no spawn near source');
        }
    }

    // --- ComboBot Anchor: adjacent to mineral + factory + terminal + factoryLink + spawn + storage ---
    var comboAnchor = null;
    if (minerals.length > 0 && factories.length > 0 && terminals.length > 0 && factoryLink && storage) {
        var factorySpawns = spawns.filter(function(sp) {
            return sp.pos.getRangeTo(factories[0]) <= 2 || sp.pos.getRangeTo(terminals[0]) <= 2;
        });
        if (factorySpawns.length > 0) {
            var comboRequired = [minerals[0], factories[0], terminals[0], factoryLink, factorySpawns[0], storage];
            comboAnchor = findAnchorTile(room, comboRequired, []);
            if (comboAnchor) {
                results.push('ComboBot anchor: (' + comboAnchor.x + ',' + comboAnchor.y + ') near factory/terminal');
            } else {
                var comboRequired2 = [minerals[0], factories[0], terminals[0], factoryLink, factorySpawns[0]];
                comboAnchor = findAnchorTile(room, comboRequired2, storage ? [storage] : []);
                if (comboAnchor) {
                    results.push('ComboBot anchor: (' + comboAnchor.x + ',' + comboAnchor.y + ') near factory (storage range 2)');
                } else {
                    results.push('ComboBot anchor: FAILED - no valid tile');
                }
            }
        } else {
            results.push('ComboBot anchor: FAILED - no spawn near factory area');
        }
    }

    // --- Distributor Anchor: adjacent to towerLink + spawn + towers ---
    var distAnchor = null;
    if (towerLink && towers.length > 0) {
        var towerSpawns = spawns.filter(function(sp) {
            for (var t = 0; t < towers.length; t++) {
                if (sp.pos.getRangeTo(towers[t]) <= 2) return true;
            }
            return false;
        });
        if (towerSpawns.length > 0) {
            var distRequired = [towerLink, towerSpawns[0], towers[0]];
            distAnchor = findAnchorTile(room, distRequired, extensions.concat(towers.slice(1)));
            if (distAnchor) {
                results.push('Distributor anchor: (' + distAnchor.x + ',' + distAnchor.y + ') near towers');
            } else {
                results.push('Distributor anchor: FAILED - no valid tile adjacent to link + spawn + tower');
            }
        } else {
            results.push('Distributor anchor: FAILED - no spawn near towers');
        }
    }

    // Store results in isolated Memory.anchors namespace
    setAnchorMemory(roomName, {
        hd: hdAnchor,
        distributor: distAnchor,
        comboBot: comboAnchor,
        linkChain: linkClass,
        hdSpawn: hdAnchor ? findSpawnNear(spawns, sources[0], 2) : null,
        distributorSpawn: distAnchor ? findSpawnNear(spawns, towers[0], 3) : null,
        comboBotSpawn: comboAnchor ? findSpawnNear(spawns, factories[0] || terminals[0], 3) : null,
        detectedAt: Game.time
    });

    var output = '[SingleSource] Anchor detection for ' + roomName + ':\n' + results.join('\n');
    console.log(output);
    return output;
}

function findSpawnNear(spawns, target, range) {
    if (!target || !spawns) return null;
    for (var i = 0; i < spawns.length; i++) {
        if (spawns[i].pos.getRangeTo(target) <= range) return spawns[i].id;
    }
    return null;
}

/**
 * Get the spawn direction to place a creep on the anchor tile.
 * Returns [direction] array suitable for spawnCreep options.
 */
function getAnchorSpawnDirection(spawnPos, anchorPos) {
    var dx = anchorPos.x - spawnPos.x;
    var dy = anchorPos.y - spawnPos.y;

    dx = dx === 0 ? 0 : (dx > 0 ? 1 : -1);
    dy = dy === 0 ? 0 : (dy > 0 ? 1 : -1);

    var key = dx + ',' + dy;
    var dir = REVERSE_DIR[key];

    if (dir !== undefined) return [dir];
    return undefined;
}

/**
 * Get anchor config for a room. Returns null if not configured.
 * Reads from Memory.anchors[roomName] (isolated namespace).
 */
function getAnchors(roomName) {
    return getAnchorMemory(roomName);
}

/**
 * Get the link chain for a 1-source room.
 * Returns ordered array of link IDs: [source, factory, tower, controller]
 */
function getLinkChain(roomName) {
    var anchors = getAnchors(roomName);
    if (!anchors || !anchors.linkChain) return null;

    var lc = anchors.linkChain;
    var chain = [];
    if (lc.source) chain.push(lc.source);
    if (lc.factory) chain.push(lc.factory);
    if (lc.tower) chain.push(lc.tower);
    if (lc.controller) chain.push(lc.controller);

    return chain.length >= 2 ? chain : null;
}

// ============================================================================
// Console Commands
// ============================================================================

global.detectAnchors = function(roomName) {
    getRoomState.init();
    return detectAnchors(roomName);
};

global.setAnchor = function(roomName, role, x, y) {
    if (!Memory.anchors) Memory.anchors = {};
    if (!Memory.anchors[roomName]) Memory.anchors[roomName] = {};
    Memory.anchors[roomName][role] = { x: x, y: y };
    return '[SingleSource] Set ' + role + ' anchor in ' + roomName + ' to (' + x + ',' + y + ')';
};

global.showAnchors = function(roomName) {
    var anchors = getAnchors(roomName);
    if (!anchors) return '[SingleSource] No anchors configured for ' + roomName;

    var lines = ['=== ANCHORS FOR ' + roomName + ' ==='];
    if (anchors.hd) lines.push('HD: (' + anchors.hd.x + ',' + anchors.hd.y + ')');
    else lines.push('HD: NOT SET');

    if (anchors.distributor) lines.push('Distributor: (' + anchors.distributor.x + ',' + anchors.distributor.y + ')');
    else lines.push('Distributor: NOT SET');

    if (anchors.comboBot) lines.push('ComboBot: (' + anchors.comboBot.x + ',' + anchors.comboBot.y + ')');
    else lines.push('ComboBot: NOT SET');

    if (anchors.linkChain) {
        var lc = anchors.linkChain;
        lines.push('Link chain: source=' + (lc.source || 'N/A') + ' factory=' + (lc.factory || 'N/A') + ' tower=' + (lc.tower || 'N/A') + ' controller=' + (lc.controller || 'N/A'));
    }

    lines.push('Detected at tick: ' + (anchors.detectedAt || 'manual'));

    var output = lines.join('\n');
    console.log(output);
    return output;
};

global.enableSingleSource = function(roomName) {
    if (!Memory.singleSourceRooms) Memory.singleSourceRooms = {};
    Memory.singleSourceRooms[roomName] = true;
    return '[SingleSource] Enabled for ' + roomName + '. Run detectAnchors(\'' + roomName + '\') to configure.';
};

global.disableSingleSource = function(roomName) {
    if (Memory.singleSourceRooms) delete Memory.singleSourceRooms[roomName];
    return '[SingleSource] Disabled for ' + roomName + '. Room will use normal creep roles.';
};

// ============================================================================
// Exports
// ============================================================================

module.exports = {
    isSingleSourceRoom: isSingleSourceRoom,
    isSingleSourceActive: isSingleSourceActive,
    getAnchors: getAnchors,
    getLinkChain: getLinkChain,
    getAnchorSpawnDirection: getAnchorSpawnDirection,
    classifyLinks: classifyLinks,
    detectAnchors: detectAnchors
};