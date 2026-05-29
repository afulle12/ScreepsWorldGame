const getRoomState = require('getRoomState');
module.exports = {
  run(creep) {
    // 1) Cache IDs (extractor, mineral, container)
    if (!creep.memory.extractorId) {
      var state = getRoomState.get(creep.room.name);
      if (!state) return creep.say('no state');
      var exts = state.structuresByType[STRUCTURE_EXTRACTOR] || [];
      var ext = null;
      for (var i = 0; i < exts.length; i++) {
        var s = exts[i];
        if (s.my) { ext = s; break; }
      }
      if (!ext) return creep.say('no ext');
      var mins = state.minerals || [];
      var min = null;
      for (var j = 0; j < mins.length; j++) {
        var m = mins[j];
        if (ext.pos.isNearTo(m.pos)) { min = m; break; }
      }
      if (!min) return creep.say('no min');
      var conts = state.structuresByType[STRUCTURE_CONTAINER] || [];
      var cont = null;
      for (var k = 0; k < conts.length; k++) {
        var c = conts[k];
        if (ext.pos.isNearTo(c.pos)) { cont = c; break; }
      }
      if (!cont) return creep.say('no cont');
      creep.memory.extractorId = ext.id;
      creep.memory.mineralId = min.id;
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
    // 3) Move onto container tile (always, even if full)
    if (!creep.pos.isEqualTo(container.pos)) {
      if (creep.fatigue > 0) return;
      return creep.moveTo(container.pos, {
        visualizePathStyle: { stroke: '#ffaa00' }
      });
    }
    // 4) Stop if the container is full (creep is already in position)
    if (container.store.getFreeCapacity() === 0) {
      creep.say('full');
      return;
    }
    // 5) Harvest the mineral
    creep.harvest(mineral);
    // 6) Drop harvested minerals (only needed if creep has CARRY parts)
    const type = mineral.mineralType;
    creep.drop(type);
  }
};