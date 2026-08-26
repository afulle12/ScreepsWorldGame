// LLM: Read docs/codex.js before reviewing or changing this file.
// roleDefender.js
// Role dispatch: memory.role === 'defender' -> roleDefender.run(creep).
// Example: require('roleDefender').run(creep);
// Example: require('roleDefender').run(creep);
var getRoomState = require("getRoomState");
module.exports = {
  run: function(o) {
    const t = o.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
    if (t) {
      if (o.attack(t) === ERR_NOT_IN_RANGE) {
        o.moveTo(t, {
          visualizePathStyle: {
            stroke: "#ff0000"
          }
        });
      }
    } else {
      if (o.hits < o.hitsMax && o.getActiveBodyparts(HEAL)) {
        o.heal(o);
      }
      if (!o.memory.patrolPoints || Game.time % 1e3 === 0) {
        initializePatrolPoints(o);
      }
      if (!o.memory.lastPos) {
        o.memory.lastPos = {
          x: o.pos.x,
          y: o.pos.y,
          stuckCount: 0
        };
      }
      if (o.pos.x === o.memory.lastPos.x && o.pos.y === o.memory.lastPos.y) {
        o.memory.lastPos.stuckCount++;
      } else {
        o.memory.lastPos = {
          x: o.pos.x,
          y: o.pos.y,
          stuckCount: 0
        };
      }
      if (o.memory.lastPos.stuckCount > 3) {
        if (o.memory.lastPos.stuckCount > 6) {
          moveRandomly(o);
          return;
        }
        o.memory.patrolIndex = (o.memory.patrolIndex + 1) % o.memory.patrolPoints.length;
      }
      const t = o.memory.patrolPoints.map(t => new RoomPosition(t[0], t[1], o.room.name));
      let e = o.memory.patrolIndex || 0;
      let s = t[e];
      if (o.pos.inRangeTo(s, 1)) {
        e = (e + 1) % t.length;
        o.memory.patrolIndex = e;
        s = t[e];
      }
      o.moveTo(s, {
        visualizePathStyle: {
          stroke: "#00ff00"
        },
        reusePath: 5,
        ignoreCreeps: true,
        plainCost: 2,
        swampCost: 10
      });
    }
  }
};
function initializePatrolPoints(o) {
  const t = [];
  const e = o.room;
  if (e.controller) {
    t.push([ e.controller.pos.x, e.controller.pos.y ]);
  }
  var s = getRoomState.get(e.name);
  var r = s && s.structuresByType && s.structuresByType[STRUCTURE_SPAWN] || [];
  for (var n = 0; n < r.length; n++) {
    var a = r[n];
    if (a.my) t.push([ a.pos.x, a.pos.y ]);
  }
  for (let o = 0; o < 3; o++) {
    const o = 10 + Math.floor(Math.random() * 30);
    const e = 10 + Math.floor(Math.random() * 30);
    t.push([ o, e ]);
  }
  const m = 3;
  t.push([ m, m ]);
  t.push([ 49 - m, m ]);
  t.push([ 49 - m, 49 - m ]);
  t.push([ m, 49 - m ]);
  o.memory.patrolPoints = t.filter(o => {
    const t = e.getTerrain();
    if (t.get(o[0], o[1]) === TERRAIN_MASK_WALL) {
      return false;
    }
    const s = e.lookForAt(LOOK_STRUCTURES, o[0], o[1]);
    for (const o of s) {
      if (o.structureType !== STRUCTURE_ROAD && OBSTACLE_OBJECT_TYPES.includes(o.structureType)) {
        return false;
      }
    }
    return true;
  });
  o.memory.patrolIndex = Math.floor(Math.random() * o.memory.patrolPoints.length);
}

function moveRandomly(o) {
  const t = [ TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT ];
  const e = t[Math.floor(Math.random() * t.length)];
  o.move(e);
  o.memory.lastPos.stuckCount = 0;
}
