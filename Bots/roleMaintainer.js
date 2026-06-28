// roleMaintainer.js
// 1. Fills the Storage Link (Link within range 2 of Storage) using energy from Storage.
// 2. Travels to Controller and upgrades until ticksToDowngrade > 199,000.
// 3. Suicides.

var getRoomState = require('getRoomState');

function _flattenStructures(structuresByType) {
    var out = [];
    for (var t in structuresByType) {
        if (!structuresByType.hasOwnProperty(t)) continue;
        var arr = structuresByType[t];
        for (var i = 0; i < arr.length; i++) out.push(arr[i]);
    }
    return out;
}

// Cost matrix callback that avoids edge tiles AND structures
function getRoomCostMatrix(roomName) {
    var room = Game.rooms[roomName];
    var costs = new PathFinder.CostMatrix;

    // Set edge tiles to impassable (255)
    for (var i = 0; i < 50; i++) {
        costs.set(i, 0, 255);   // Top edge
        costs.set(i, 49, 255);  // Bottom edge
        costs.set(0, i, 255);   // Left edge
        costs.set(49, i, 255);  // Right edge
    }

    if (!room) return costs;

    var rs = getRoomState.get(roomName);
    var allStructures = (rs && rs.structuresByType) ? _flattenStructures(rs.structuresByType) : room.find(FIND_STRUCTURES);

    // Mark structures appropriately
    for (var si = 0; si < allStructures.length; si++) {
        var struct = allStructures[si];
        if (struct.structureType === STRUCTURE_ROAD) {
            // Prefer roads (lower cost)
            costs.set(struct.pos.x, struct.pos.y, 1);
        } else if (struct.structureType !== STRUCTURE_CONTAINER &&
                   (struct.structureType !== STRUCTURE_RAMPART || !struct.my)) {
            // Non-walkable structures = impassable
            costs.set(struct.pos.x, struct.pos.y, 255);
        }
    }

    // Avoid other creeps (myCreeps + hostiles; missed neutrals are rare in owned rooms)
    if (rs) {
        var myCreeps = rs.myCreeps || [];
        for (var mi = 0; mi < myCreeps.length; mi++) {
            costs.set(myCreeps[mi].pos.x, myCreeps[mi].pos.y, 255);
        }
        var hostiles = rs.hostiles || [];
        for (var hi = 0; hi < hostiles.length; hi++) {
            costs.set(hostiles[hi].pos.x, hostiles[hi].pos.y, 255);
        }
    } else {
        room.find(FIND_CREEPS).forEach(function(creep) {
            costs.set(creep.pos.x, creep.pos.y, 255);
        });
    }

    return costs;
}

// Common moveTo options with edge and structure avoidance
function getMoveOpts(extraOpts) {
    var opts = {
        costCallback: getRoomCostMatrix
    };
    for (var key in extraOpts) {
        opts[key] = extraOpts[key];
    }
    return opts;
}

module.exports = {
    run: function(creep) {
        if (creep.spawning) return;

        // 1. CHECK EXIT CONDITION
        // If we have reached the target buffer, our job is done.
        if (creep.room.controller && creep.room.controller.ticksToDowngrade > 199000) {
            creep.say("Done");
            console.log(creep.name + " finished maintenance in " + creep.room.name + ". Suiciding.");
            creep.suicide();
            return;
        }

        // 2. DETERMINE PHASE
        // Phase A: Fill Storage Link
        // Phase B: Maintain Controller
        if (!creep.memory.phase) {
            // If a supplier is already spawned in this room, skip the link
            // fill phase — the supplier handles storage link fills as part
            // of its normal duties. Go straight to upgrading the controller.
            if (isSupplierSpawned(creep.room)) {
                creep.memory.phase = 'maintain';
            } else {
                creep.memory.phase = 'fillLink';
            }
        }

        if (creep.memory.phase === 'fillLink') {
            runFillLink(creep);
        } else {
            runMaintain(creep);
        }
    }
};

// --- PHASE 1: FILL STORAGE LINK ---
function runFillLink(creep) {
    var room = creep.room;

    // Validate Storage exists
    if (!room.storage) {
        console.log(creep.name + ": No storage found in " + room.name + ", skipping link fill.");
        creep.memory.phase = 'maintain';
        return;
    }

    // Find the Storage Link (Range 2 from storage)
    var storageLink = getStorageLink(creep);

    // If no link exists, or it is already full, switch to next phase
    if (!storageLink) {
        // No link found near storage, skip
        creep.memory.phase = 'maintain';
        return;
    }

    // Check if link is full
    if (storageLink.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
        creep.memory.phase = 'maintain';
        return;
    }

    // Perform the work
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
        // Withdraw from storage
        if (creep.withdraw(room.storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
            creep.moveTo(room.storage, getMoveOpts({ visualizePathStyle: { stroke: '#ffaa00' } }));
        }
    } else {
        // Transfer to link
        if (creep.transfer(storageLink, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
            creep.moveTo(storageLink, getMoveOpts({ visualizePathStyle: { stroke: '#ffffff' } }));
        }
    }
}

// --- PHASE 2: MAINTAIN CONTROLLER ---
function runMaintain(creep) {
    var controller = creep.room.controller;

    if (!controller) return;

    // Logic: Get Energy -> Upgrade
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
        getMaintenanceEnergy(creep);
    } else {
        if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
            creep.moveTo(controller, getMoveOpts({ range: 3, visualizePathStyle: { stroke: '#00ff00' } }));
        }
    }
}

// --- HELPERS ---

function isSupplierSpawned(room) {
    if (!room) return false;
    var rs = getRoomState.get(room.name);
    if (rs && rs.myCreeps) {
        for (var i = 0; i < rs.myCreeps.length; i++) {
            var c = rs.myCreeps[i];
            if (c.memory && c.memory.role === 'supplier') return true;
        }
        return false;
    }
    var suppliers = room.find(FIND_MY_CREEPS, {
        filter: function(c) { return c.memory && c.memory.role === 'supplier'; }
    });
    return suppliers.length > 0;
}

function getStorageLink(creep) {
    // Uses getRoomState for efficiency if available, falls back to find
    var rs = getRoomState.get(creep.room.name);
    var links = [];

    if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_LINK]) {
        var allLinks = rs.structuresByType[STRUCTURE_LINK];
        for (var li = 0; li < allLinks.length; li++) {
            if (allLinks[li].my) links.push(allLinks[li]);
        }
    } else {
        links = creep.room.find(FIND_MY_STRUCTURES, {
            filter: function(s) { return s.structureType === STRUCTURE_LINK; }
        });
    }

    var storagePos = creep.room.storage.pos;

    // Find link in range 2 of storage
    for (var i = 0; i < links.length; i++) {
        if (links[i].pos.getRangeTo(storagePos) <= 2) {
            return links[i];
        }
    }
    return null;
}

function getMaintenanceEnergy(creep) {
    // Since the creep is at the controller now, it should look for energy nearby.
    // 1. Link near controller
    // 2. Container near controller
    // 3. Storage (Remote fallback)

    var rs = getRoomState.get(creep.room.name);

    // Try to find a link near the creep (assuming creep is near controller) or near controller
    var controllerLink = null;

    // Check known links from RoomState
    if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_LINK]) {
        var links = rs.structuresByType[STRUCTURE_LINK];
        for (var i = 0; i < links.length; i++) {
            // If link is close to controller (range 4 covers most layouts) and has energy
            if (links[i].pos.getRangeTo(creep.room.controller) <= 4 && 
                links[i].store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                controllerLink = links[i];
                break;
            }
        }
    }

    if (controllerLink) {
        if (creep.withdraw(controllerLink, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
            creep.moveTo(controllerLink, getMoveOpts({ visualizePathStyle: { stroke: '#ffaa00' } }));
        }
        return;
    }

    // Fallback: Containers
    var container = creep.pos.findClosestByRange(FIND_STRUCTURES, {
        filter: function(s) {
            return s.structureType === STRUCTURE_CONTAINER && 
                   s.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
        }
    });

    if (container) {
        if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
            creep.moveTo(container, getMoveOpts({ visualizePathStyle: { stroke: '#ffaa00' } }));
        }
        return;
    }

    // Final Fallback: Go back to storage (long walk)
    if (creep.room.storage && creep.room.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        if (creep.withdraw(creep.room.storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
            creep.moveTo(creep.room.storage, getMoveOpts({ visualizePathStyle: { stroke: '#ffaa00' } }));
        }
    }
}
