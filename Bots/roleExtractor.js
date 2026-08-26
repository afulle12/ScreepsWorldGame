// LLM: Read docs/codex.js before reviewing or changing this file.
// roleExtractor.js
// Role dispatch: memory.role === 'extractor' -> roleExtractor.run(creep).
// Example: require('roleExtractor').run(creep);
// Example: require('roleExtractor').run(creep);
const getRoomState = require("getRoomState");
module.exports = {
  run(e) {
    if (!e.memory.extractorId) {
      var r = getRoomState.get(e.room.name);
      if (!r) return e.say("no state");
      var t = r.structuresByType[STRUCTURE_EXTRACTOR] || [];
      var o = null;
      for (var a = 0; a < t.length; a++) {
        var n = t[a];
        if (n.my) {
          o = n;
          break;
        }
      }
      if (!o) return e.say("no ext");
      var m = r.minerals || [];
      var i = null;
      for (var s = 0; s < m.length; s++) {
        var y = m[s];
        if (o.pos.isNearTo(y.pos)) {
          i = y;
          break;
        }
      }
      if (!i) return e.say("no min");
      var l = r.structuresByType[STRUCTURE_CONTAINER] || [];
      var u = null;
      for (var d = 0; d < l.length; d++) {
        var c = l[d];
        if (o.pos.isNearTo(c.pos)) {
          u = c;
          break;
        }
      }
      if (!u) return e.say("no cont");
      e.memory.extractorId = o.id;
      e.memory.mineralId = i.id;
      e.memory.containerId = u.id;
    }
    const f = Game.getObjectById(e.memory.extractorId);
    const v = Game.getObjectById(e.memory.mineralId);
    const I = Game.getObjectById(e.memory.containerId);
    if (!f || !v || !I) {
      delete e.memory.extractorId;
      delete e.memory.mineralId;
      delete e.memory.containerId;
      return;
    }
    if (!e.pos.isEqualTo(I.pos)) {
      if (e.fatigue > 0) return;
      return e.moveTo(I.pos, {
        visualizePathStyle: {
          stroke: "#ffaa00"
        }
      });
    }
    if (I.store.getFreeCapacity() === 0) {
      e.say("full");
      return;
    }
    e.harvest(v);
    const T = v.mineralType;
    e.drop(T);
  }
};
