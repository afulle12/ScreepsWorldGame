// squadModule.js
const iff = require('iff');

module.exports = {
  spawnSquads(formRoom, attackRoom, numSquads) {
    if (!Memory.squadQueues) Memory.squadQueues = [];
    for (let i = 0; i < numSquads; i++) {
      const squadId = `${formRoom}_${attackRoom}_${Game.time}_${i}`;
      Memory.squadQueues.push({ squadId, formRoom, attackRoom, membersToSpawn: 4 });
    }
  },

  processSpawnQueue(roomName) {
    if (!Memory.squadQueues || Memory.squadQueues.length === 0) return;
    const room = Game.rooms[roomName];
    const spawns = room.find(FIND_MY_SPAWNS).filter(s => !s.spawning);
    if (spawns.length === 0) return;

    for (let i = Memory.squadQueues.length - 1; i >= 0; i--) {
      const queue = Memory.squadQueues[i];
      if (queue.formRoom !== roomName || queue.membersToSpawn <= 0) continue;

      const spawn = spawns[0];
      const body = this.getBody(room);
      const name = `Squad_${queue.squadId}_${Game.time}`;
      const position = 4 - queue.membersToSpawn;
      const memory = {
        role: 'squadMember',
        squadId: queue.squadId,
        formRoom: queue.formRoom,
        attackRoom: queue.attackRoom,
        position
      };

      if (spawn.spawnCreep(body, name, { memory }) === OK) {
        queue.membersToSpawn--;
        if (queue.membersToSpawn === 0) {
          Memory.squadQueues.splice(i, 1);
        }
        return;
      }
    }
  },

  getBody(room) {
    const energy = room.energyAvailable;
    const numSets = Math.min(16, Math.floor(energy / 390));
    const body = [];
    for (let i = 0; i < numSets; i++) {
      body.push(TOUGH, MOVE, ATTACK, HEAL);
    }
    return body;
  },

  run(creep) {
    // Enhanced debugging for invalid creep calls
    if (!creep) {
      console.log('[Squad] Warning: run() called with undefined creep');
      console.trace(); // This will show us exactly where the call is coming from
      return;
    }

    if (!creep.memory) {
      console.log('[Squad] Warning: run() called with creep that has no memory:', creep.name);
      console.trace();
      return;
    }

    const squad = this.getSquadMembers(creep.memory.squadId);
    if (squad.length < 4) {
      creep.moveTo(Game.rooms[creep.memory.formRoom].controller);
      return;
    }

    const sortedSquad = _.sortBy(squad, c => c.memory.position);
    const myIndex = sortedSquad.findIndex(c => c.id === creep.id);
    const leader = sortedSquad[0];

    // Check if all in same room
    const rooms = _.uniq(squad.map(c => c.room.name));
    if (rooms.length > 1) {
      creep.moveTo(leader);
      return;
    }

    // Healing logic
    const damaged = _.sortBy(squad.filter(c => c.hits < c.hitsMax), c => c.hits);
    if (damaged.length > 0) {
      const target = creep.pos.findClosestByRange(damaged);
      if (creep.heal(target) === ERR_NOT_IN_RANGE) {
        creep.rangedHeal(target);
      } else {
        creep.heal(target);
      }
    }
    if (creep.hits < creep.hitsMax) {
      creep.heal(creep);
    }

    const inAttackRoom = creep.room.name === creep.memory.attackRoom;

    let target = null;
    if (inAttackRoom) {
      target = this.getAttackTarget(creep.room);
      if (target) {
        if (creep.attack(target) === ERR_NOT_IN_RANGE) {
          // Move handled below
        }
      }
    }

    // Movement logic
    if (inAttackRoom) {
      // Square formation: all move to target for clustering
      if (target) {
        creep.moveTo(target);
      }
    } else {
      // Train formation: follow the leader
      let moveTarget;
      if (myIndex === 0) {
        const exitDir = Game.map.findExit(creep.room.name, creep.memory.attackRoom);
        if (exitDir === ERR_NO_PATH || exitDir === ERR_INVALID_ARGS) return;
        moveTarget = creep.pos.findClosestByRange(exitDir);
        creep.moveTo(moveTarget);
      } else {
        const previous = sortedSquad[myIndex - 1];
        creep.moveTo(previous);
      }
    }
  },

  getSquadMembers(squadId) {
    return _.filter(Game.creeps, c => 
      c && 
      c.memory && 
      c.memory.role === 'squadMember' && 
      c.memory.squadId === squadId
    );
  },

  getAttackTarget(room) {
    const isHostileStructure = (s) => s.owner && iff.isHostileCreep({ owner: s.owner });

    const hostileTowers = room.find(FIND_STRUCTURES, {
      filter: s => s.structureType === STRUCTURE_TOWER && isHostileStructure(s)
    });
    const emptyTowers = hostileTowers.filter(t => t.store[RESOURCE_ENERGY] === 0);
    const allEmpty = hostileTowers.length > 0 && emptyTowers.length === hostileTowers.length;

    if (allEmpty && emptyTowers.length > 0) {
      return room.controller.pos.findClosestByPath(emptyTowers);
    } else if (hostileTowers.length > 0) {
      return room.controller.pos.findClosestByPath(hostileTowers);
    }

    const spawns = room.find(FIND_STRUCTURES, {
      filter: s => s.structureType === STRUCTURE_SPAWN && isHostileStructure(s)
    });
    if (spawns.length > 0) {
      return room.controller.pos.findClosestByPath(spawns);
    }

    const others = room.find(FIND_STRUCTURES, {
      filter: s => isHostileStructure(s) && s.structureType !== STRUCTURE_WALL && s.structureType !== STRUCTURE_ROAD && s.structureType !== STRUCTURE_CONTROLLER
    });
    if (others.length > 0) {
      return room.controller.pos.findClosestByPath(others);
    }

    return null;
  }
};
