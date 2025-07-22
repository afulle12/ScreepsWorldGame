const iff = require('iff');

//// Attack with auto-selected rally room (closest to target)
//global.orderAttack('E3N44', 5)

// Attack with specific rally room
//global.orderAttack('E3N44', 5, 'E3N45')


const roleAttacker = {
  /** @param {Creep} creep **/
  run: function(creep) {
    const targetRoom = creep.memory.targetRoom;
    const rallyRoom = creep.memory.rallyRoom;

    // Phase 1: Move to rally room if not there yet
    if (!creep.memory.rallyComplete && creep.room.name !== rallyRoom) {
      creep.moveTo(new RoomPosition(25, 25, rallyRoom), {
        visualizePathStyle: { stroke: '#00ff00', lineStyle: 'dotted' }
      });
      creep.say(`🛡️ ${rallyRoom}`);
      return;
    }

    // Phase 2: Rally in rally room
    if (!creep.memory.rallyComplete && creep.room.name === rallyRoom) {
      const rallyResult = this.handleRallyPhase(creep);
      if (!rallyResult) return; // Still rallying
    }

    // Phase 3: Move to target room
    if (creep.room.name !== targetRoom) {
      creep.moveTo(new RoomPosition(25, 25, targetRoom), {
        visualizePathStyle: { stroke: '#ff0000', lineStyle: 'dashed' }
      });
      creep.say(`⚔️ ${targetRoom}`);
      return;
    }

    // Phase 4: Combat logic (same as before)
    const hasHealParts = creep.body.some(part => part.type === HEAL && part.hits > 0);
    if (hasHealParts && creep.hits < creep.hitsMax) {
      const healResult = creep.heal(creep);
      if (healResult === OK) {
        creep.say('🩹 HEAL');
      }
    }

    // [Rest of your existing combat logic remains exactly the same]

    let target = null;
    if (creep.memory.targetId && Game.time % 5 !== 0) {
      target = Game.getObjectById(creep.memory.targetId);
      if (target) {
        creep.say('💥 ATTACK!');
        const err = creep.attack(target);
        if (err === ERR_NOT_IN_RANGE) {
          creep.moveTo(target, { visualizePathStyle: { stroke: '#ff0000' } });
        }
        return;
      } else {
        delete creep.memory.targetId;
      }
    }

    if (creep.memory.assignedTargetId) {
      target = Game.getObjectById(creep.memory.assignedTargetId);
      if (!target) delete creep.memory.assignedTargetId;
    }

    if (!target) {
      target = creep.pos.findClosestByPath(FIND_HOSTILE_CREEPS, {
        filter: c => iff.isHostileCreep(c)
      });
    }

    if (!target) {
      target = creep.pos.findClosestByPath(FIND_HOSTILE_STRUCTURES, {
        filter: s => {
          if (
            s.structureType === STRUCTURE_CONTROLLER ||
            s.structureType === STRUCTURE_KEEPER_LAIR
          ) return false;
          if (s.owner && iff.IFF_WHITELIST.includes(s.owner.username)) {
            return false;
          }
          return true;
        }
      });
    }

    if (!target) {
      target = creep.pos.findClosestByPath(FIND_HOSTILE_CONSTRUCTION_SITES);
    }

    if (target) {
      const standardRoomCallback = () => {
        const matrix = new PathFinder.CostMatrix();
        const room = Game.rooms[creep.room.name];
        if (room) {
          room.find(FIND_STRUCTURES).forEach(s => {
            if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) {
              matrix.set(s.pos.x, s.pos.y, 255);
            }
          });
        }
        return matrix;
      };

      const standardPathRes = PathFinder.search(
        creep.pos, { pos: target.pos, range: 1 },
        {
          maxOps: 1000,
          plainCost: 1,
          swampCost: 5,
          roomCallback: standardRoomCallback
        }
      );

      if (standardPathRes.path.length === 0) {
        const wallRoomCallback = () => {
          const matrix = new PathFinder.CostMatrix();
          const room = Game.rooms[creep.room.name];
          if (room) {
            room.find(FIND_STRUCTURES).forEach(s => {
              if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) {
                matrix.set(s.pos.x, s.pos.y, 1);
              }
            });
          }
          return matrix;
        };

        const wallPathRes = PathFinder.search(
          creep.pos, { pos: target.pos, range: 1 },
          {
            maxOps: 1000,
            plainCost: 1,
            swampCost: 5,
            roomCallback: wallRoomCallback
          }
        );

        const blockers = [];
        for (const step of wallPathRes.path) {
          const structs = creep.room.lookForAt(LOOK_STRUCTURES, step.x, step.y);
          for (const s of structs) {
            if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) {
              blockers.push(s);
            }
          }
        }

        if (blockers.length) {
          target = blockers.reduce((weakest, s) => s.hits < weakest.hits ? s : weakest, blockers[0]);
        }
      }
    }

    if (target) {
      creep.memory.targetId = target.id;
    }

    if (target) {
      creep.say('💥 ATTACK!');
      const err = creep.attack(target);
      if (err === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, { visualizePathStyle: { stroke: '#ff0000' } });
      }
      return;
    }

    const allBarriers = creep.room.find(FIND_STRUCTURES, {
      filter: s =>
        s.structureType === STRUCTURE_WALL ||
        s.structureType === STRUCTURE_RAMPART
    });

    if (allBarriers.length) {
      const edgeBarriers = allBarriers.filter(s =>
        s.pos.x === 0 ||
        s.pos.x === 49 ||
        s.pos.y === 0 ||
        s.pos.y === 49
      );

      const candidates = edgeBarriers.length ? edgeBarriers : allBarriers;
      const wallTarget = candidates.reduce((weakest, s) => s.hits < weakest.hits ? s : weakest, candidates[0]);

      if (wallTarget) {
        creep.memory.targetId = wallTarget.id;
        creep.say('🪨 BUST');
        if (creep.attack(wallTarget) === ERR_NOT_IN_RANGE) {
          creep.moveTo(wallTarget, {
            visualizePathStyle: { stroke: '#ffaa00' }
          });
        }
        return;
      }
    }

    delete creep.memory.targetId;
    creep.moveTo(new RoomPosition(25, 25, targetRoom), {
      visualizePathStyle: { stroke: '#cccccc' }
    });
    creep.say('⚔️ IDLE');
  },

  /**
   * Handles the rally phase in the rally room
   * @param {Creep} creep 
   * @returns {boolean} true if rally is complete, false if still rallying
   */
  handleRallyPhase: function(creep) {
    const orderIndex = creep.memory.orderIndex;

    // Check if order still exists
    if (!Memory.attackOrders || !Memory.attackOrders[orderIndex]) {
      creep.memory.rallyComplete = true;
      return true;
    }

    const order = Memory.attackOrders[orderIndex];
    const rallyPoint = new RoomPosition(order.rallyPoint.x, order.rallyPoint.y, creep.memory.rallyRoom);

    // If rally phase is complete globally, this creep can proceed
    if (order.rallyPhase === 'attacking') {
      creep.memory.rallyComplete = true;
      return true;
    }

    // Move to rally point
    const range = creep.pos.getRangeTo(rallyPoint);
    if (range > 3) {
      creep.moveTo(rallyPoint, {
        visualizePathStyle: { stroke: '#00ff00', lineStyle: 'dotted' }
      });
      creep.say(`🛡️ RALLY`);
    } else {
      // At rally point, show status
      const attackersAtRally = _.filter(Game.creeps, c => 
        c.memory.role === 'attacker' && 
        c.memory.targetRoom === order.targetRoom &&
        c.room.name === order.rallyRoom
      );

      const rallyTimeElapsed = order.rallyStartTime ? Game.time - order.rallyStartTime : 0;
      const remaining = Math.max(0, 50 - rallyTimeElapsed);

      creep.say(`⏳ ${attackersAtRally.length}/${order.spawned} (${remaining})`);
    }

    return false; // Still rallying
  }
};

module.exports = roleAttacker;
