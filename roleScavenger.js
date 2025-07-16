// roleScavenger.js
module.exports = {
  /** @param {Creep} creep **/
  run: function(creep) {
    // 1) Send an email notification once when this scavenger first runs
    if (!creep.memory.notified) {
      Game.notify(`Scavenger spawned: ${creep.name} in ${creep.room.name}`);
      creep.memory.notified = true;
    }

    const storage    = creep.room.storage;
    const controller = creep.room.controller;

    // 2) If carrying anything, deliver it
    if (_.sum(creep.carry) > 0) {
      if (storage) {
        // Deliver all carried resources to storage
        for (const resourceType in creep.carry) {
          if (creep.transfer(storage, resourceType) === ERR_NOT_IN_RANGE) {
            creep.moveTo(storage, { visualizePathStyle: { stroke: '#ffaa00' } });
          }
          return;
        }
      } else {
        // No storage: wait by the controller if carrying energy
        if (creep.carry.energy > 0 &&
            creep.pos.getRangeTo(controller) > 1) {
          creep.moveTo(controller, { visualizePathStyle: { stroke: '#ffffff' } });
        }
        return;
      }
    }

    // 3) Not carrying: pick up dropped resources
    let dropTarget;
    if (storage) {
      dropTarget = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES);
    } else {
      dropTarget = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
        filter: r => r.resourceType === RESOURCE_ENERGY
      });
    }

    if (dropTarget) {
      if (creep.pickup(dropTarget) === ERR_NOT_IN_RANGE) {
        creep.moveTo(dropTarget, { visualizePathStyle: { stroke: '#ffffff' } });
      }
    } else {
      // 4) No tasks left: wait next to the controller
      if (creep.pos.getRangeTo(controller) > 1) {
        creep.moveTo(controller, { visualizePathStyle: { stroke: '#ffffff' } });
      }
    }
  }
};
