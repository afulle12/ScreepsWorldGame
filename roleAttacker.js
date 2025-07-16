/**
 * roleAttacker.js
 *
 * The Attacker role uses iff.js to avoid friendly targets.
 * Priority:
 *   0. assignedTargetId (memory)
 *   1. hostile creeps
 *   2. hostile structures
 *   3. hostile construction sites
 *   4. walls/ramparts *in the way* of that target (weakest first)
 *   5. room perimeter walls/ramparts (weakest first)
 */
 
 /**
 * The Attacker role uses iff.js to avoid friendly targets.
 * It prioritizes an assigned target, then hostile creeps, then hostile structures.
 *
 * --- HOW TO USE ---
 * 1. Order attackers to a room from the console:
 *    > global.orderAttack('E3N44', 3)
 *
 * 2. (Optional) Assign a specific target ID to all attackers in that room:
 *    > Game.assignAttackTarget('W1N8', '5bbcac4c9099fc012e635e3a')
 *
 * Memory:
 *  - role: 'attacker'
 *  - targetRoom: The room to attack.
 *  - homeRoom: The room it was spawned from.
 *  - assignedTargetId: (Optional) The ID of a specific target to focus on.
 */

const iff = require('iff');

const roleAttacker = {
  /** @param {Creep} creep **/
  run: function(creep) {
    const targetRoom = creep.memory.targetRoom;

    // 1) Move into the target room
    if (creep.room.name !== targetRoom) {
      creep.moveTo(new RoomPosition(25, 25, targetRoom), {
        visualizePathStyle: { stroke: '#ff0000', lineStyle: 'dashed' }
      });
      creep.say(`⚔️ ${targetRoom}`);
      return;
    }

    // 2) Pick the “real” target
    let target = null;

    // 2.0 Assigned target
    if (creep.memory.assignedTargetId) {
      target = Game.getObjectById(creep.memory.assignedTargetId);
      if (!target) delete creep.memory.assignedTargetId;
    }

    // 2.1 Hostile creeps
    if (!target) {
      target = creep.pos.findClosestByPath(FIND_HOSTILE_CREEPS, {
        filter: c => iff.isHostileCreep(c)
      });
    }

    // 2.2 Hostile structures (excl. controllers/lairs + IFF whitelist)
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

    // 2.3 Hostile construction sites
    if (!target) {
      target = creep.pos.findClosestByPath(FIND_HOSTILE_CONSTRUCTION_SITES);
    }

    // 3) If we have a “real” target, see if any walls/ramparts block the path
    if (target) {
      // a) CostMatrix treating walls & ramparts as walkable
      const roomCallback = roomName => {
        const matrix = new PathFinder.CostMatrix();
        const room = Game.rooms[roomName];
        if (!room) return matrix;
        room.find(FIND_STRUCTURES).forEach(s => {
          if (
            s.structureType === STRUCTURE_WALL ||
            s.structureType === STRUCTURE_RAMPART
          ) {
            matrix.set(s.pos.x, s.pos.y, 1);
          }
        });
        return matrix;
      };

      // b) Search path through walls
      const pathRes = PathFinder.search(
        creep.pos, { pos: target.pos, range: 1 },
        {
          maxOps: 1000,
          plainCost: 1,
          swampCost: 5,
          roomCallback
        }
      );

      // c) Collect any walls/ramparts along that path
      const blockers = [];
      for (const step of pathRes.path) {
        const structs = creep.room.lookForAt(LOOK_STRUCTURES, step.x, step.y);
        for (const s of structs) {
          if (
            s.structureType === STRUCTURE_WALL ||
            s.structureType === STRUCTURE_RAMPART
          ) {
            blockers.push(s);
          }
        }
      }

      // d) If blockers exist, override target to the *weakest* one
      if (blockers.length) {
        target = blockers.reduce((weakest, s) =>
          s.hits < weakest.hits ? s : weakest
        , blockers[0]);
      }
    }

    // 4) Attack / move logic
    if (target) {
      creep.say('💥 ATTACK!');
      const err = creep.attack(target);
      if (err === ERR_NOT_IN_RANGE) {
        creep.moveTo(target, { visualizePathStyle: { stroke: '#ff0000' } });
      }
      return;
    }

    // 5) No valid hostile target → break perimeter walls/ramparts (weakest first)
    const allBarriers = creep.room.find(FIND_STRUCTURES, {
      filter: s =>
        s.structureType === STRUCTURE_WALL ||
        s.structureType === STRUCTURE_RAMPART
    });

    if (allBarriers.length) {
      // a) True perimeter
      const edgeBarriers = allBarriers.filter(s =>
        s.pos.x === 0 ||
        s.pos.x === 49 ||
        s.pos.y === 0 ||
        s.pos.y === 49
      );

      const candidates = edgeBarriers.length ? edgeBarriers : allBarriers;

      // b) Pick the barrier with the lowest hits (weakest)
      const wallTarget = candidates.reduce((weakest, s) =>
        s.hits < weakest.hits ? s : weakest
      , candidates[0]);

      if (wallTarget) {
        creep.say('🪨 BUST');
        if (creep.attack(wallTarget) === ERR_NOT_IN_RANGE) {
          creep.moveTo(wallTarget, {
            visualizePathStyle: { stroke: '#ffaa00' }
          });
        }
        return;
      }
    }

    // 6) Nothing left → idle at center
    creep.moveTo(new RoomPosition(25, 25, targetRoom), {
      visualizePathStyle: { stroke: '#cccccc' }
    });
    creep.say('⚔️ IDLE');
  }
};

module.exports = roleAttacker;
