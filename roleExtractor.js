// roleExtractor.js

module.exports = {
  run(creep) {
    // 1) Cache IDs (extractor, mineral, container)
    if (!creep.memory.extractorId) {
      const ext = creep.room.find(FIND_MY_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_EXTRACTOR
      })[0];
      if (!ext) return creep.say('no ext');

      const min = ext.pos.findInRange(FIND_MINERALS, 1)[0];
      if (!min) return creep.say('no min');

      const cont = ext.pos.findInRange(FIND_STRUCTURES, 1, {
        filter: s => s.structureType === STRUCTURE_CONTAINER
      })[0];
      if (!cont) return creep.say('no cont');

      creep.memory.extractorId = ext.id;
      creep.memory.mineralId  = min.id;
      creep.memory.containerId = cont.id;
    }

    const extractor = Game.getObjectById(creep.memory.extractorId);
    const mineral   = Game.getObjectById(creep.memory.mineralId);
    const container = Game.getObjectById(creep.memory.containerId);

    // 2) Reset if any object is gone
    if (!extractor || !mineral || !container) {
      delete creep.memory.extractorId;
      delete creep.memory.mineralId;
      delete creep.memory.containerId;
      return;
    }

    // 3) Move onto container tile
    if (!creep.pos.isEqualTo(container.pos)) {
      return creep.moveTo(container.pos, {
        visualizePathStyle: { stroke: '#ffaa00' }
      });
    }

    // 4) Harvest the mineral
    const res = creep.harvest(mineral);
    if (res === ERR_NOT_IN_RANGE) {
      return creep.moveTo(mineral, {
        visualizePathStyle: { stroke: '#ffffff' }
      });
    }

    // 5) Immediately drop what was harvested
    const type = mineral.mineralType;
    creep.drop(type);
  }
};
