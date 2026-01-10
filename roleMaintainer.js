// roleMaintainer.js
// 1. Fills the Storage Link (Link within range 2 of Storage) using energy from Storage.
// 2. Travels to Controller and upgrades until ticksToDowngrade > 199,000.
// 3. Suicides.

var getRoomState = require('getRoomState');

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
            creep.memory.phase = 'fillLink';
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
            creep.moveTo(room.storage, { visualizePathStyle: { stroke: '#ffaa00' } });
        }
    } else {
        // Transfer to link
        if (creep.transfer(storageLink, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
            creep.moveTo(storageLink, { visualizePathStyle: { stroke: '#ffffff' } });
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
            creep.moveTo(controller, { range: 3, visualizePathStyle: { stroke: '#00ff00' } });
        }
    }
}

// --- HELPERS ---

function getStorageLink(creep) {
    // Uses getRoomState for efficiency if available, falls back to find
    var rs = getRoomState.get(creep.room.name);
    var links = [];

    if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_LINK]) {
        links = rs.structuresByType[STRUCTURE_LINK];
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
            creep.moveTo(controllerLink, { visualizePathStyle: { stroke: '#ffaa00' } });
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
            creep.moveTo(container, { visualizePathStyle: { stroke: '#ffaa00' } });
        }
        return;
    }

    // Final Fallback: Go back to storage (long walk)
    if (creep.room.storage && creep.room.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        if (creep.withdraw(creep.room.storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
            creep.moveTo(creep.room.storage, { visualizePathStyle: { stroke: '#ffaa00' } });
        }
    }
}