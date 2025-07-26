// squadModule.js

//    global.orderSquad(formRoom, attackRoom, numSquads) 
//    orderSquad('E1S1', 'W1N1', 2) - Orders 2 squads from E1S1 to attack W1N1
//    cancelSquadOrder('W1N1') - Cancels all squad orders targeting W1N1


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
    // Ensure at least one MOVE part per creep for quad movement
    const numSets = Math.min(16, Math.floor(energy / 390));
    const body = [];
    for (let i = 0; i < numSets; i++) {
      body.push(TOUGH, MOVE, ATTACK, HEAL);
    }
    return body;
  },

  // Check if quad is properly packed in 2x2 formation
  isQuadPacked(creeps) {
    if (creeps.length !== 4) return false;
    for (let i = 0; i < creeps.length; i++) {
      for (let j = i + 1; j < creeps.length; j++) {
        if (!creeps[i].pos.isNearTo(creeps[j].pos)) return false;
      }
    }
    return true;
  },

  // Find empty 2x2 area near creeps for packing
  findEmptySquareArea(creeps) {
    if (creeps.length === 0) return null;

    const centerPos = this.getCenterPosition(creeps);
    const room = Game.rooms[centerPos.roomName];

    // Search in expanding radius from center
    for (let range = 1; range <= 10; range++) {
      for (let x = centerPos.x - range; x <= centerPos.x + range; x++) {
        for (let y = centerPos.y - range; y <= centerPos.y + range; y++) {
          if (x < 1 || x > 48 || y < 1 || y > 48) continue;

          // Check if 2x2 area starting at (x,y) is empty
          let isEmpty = true;
          const positions = [
            new RoomPosition(x, y, centerPos.roomName),
            new RoomPosition(x + 1, y, centerPos.roomName),
            new RoomPosition(x, y + 1, centerPos.roomName),
            new RoomPosition(x + 1, y + 1, centerPos.roomName)
          ];

          for (const pos of positions) {
            if (pos.x > 49 || pos.y > 49) {
              isEmpty = false;
              break;
            }

            const terrain = room.getTerrain();
            if (terrain.get(pos.x, pos.y) === TERRAIN_MASK_WALL) {
              isEmpty = false;
              break;
            }

            const creepsAt = pos.lookFor(LOOK_CREEPS);
            const structuresAt = pos.lookFor(LOOK_STRUCTURES);
            if (creepsAt.length > 0 || structuresAt.some(s => s.structureType !== STRUCTURE_ROAD)) {
              isEmpty = false;
              break;
            }
          }

          if (isEmpty) {
            return positions[0]; // Return top-left position
          }
        }
      }
    }
    return null;
  },

  // Get center position of creeps
  getCenterPosition(creeps) {
    const avgX = Math.round(_.sum(creeps, c => c.pos.x) / creeps.length);
    const avgY = Math.round(_.sum(creeps, c => c.pos.y) / creeps.length);
    return new RoomPosition(avgX, avgY, creeps[0].pos.roomName);
  },

  // Transform cost matrix for quad movement
  transformCosts(costs, roomName, swampCost = 5, plainCost = 1) {
    const terrain = Game.map.getRoomTerrain(roomName);
    const result = new PathFinder.CostMatrix();
    const formationVectors = [
      { x: 0, y: 0 },  // top-left (leader)
      { x: 1, y: 0 },  // top-right
      { x: 0, y: 1 },  // bottom-left
      { x: 1, y: 1 }   // bottom-right
    ];

    for (let x = 0; x < 50; x++) {
      for (let y = 0; y < 50; y++) {
        let cost = undefined;

        for (const vector of formationVectors) {
          const newX = x + vector.x;
          const newY = y + vector.y;

          if (newX >= 50 || newY >= 50) {
            cost = 255;
            break;
          }

          let newCost = costs.get(newX, newY);
          if (newCost === 0) {
            const terrainMask = terrain.get(newX, newY);
            if (terrainMask === TERRAIN_MASK_WALL) {
              newCost = 255;
            } else if (terrainMask === TERRAIN_MASK_SWAMP) {
              newCost = swampCost;
            } else {
              newCost = plainCost;
            }
          }

          if (cost === undefined) {
            cost = newCost;
          } else {
            cost = Math.max(cost, newCost);
          }
        }

        result.set(x, y, cost);
      }
    }
    return result;
  },

  run(creep) {
    if (!creep || !creep.memory) {
      console.log('[Squad] Warning: run() called with invalid creep');
      return;
    }

    const squad = this.getSquadMembers(creep.memory.squadId);
    if (squad.length < 4) {
      creep.moveTo(Game.rooms[creep.memory.formRoom].controller);
      return;
    }

    // **Step 1: Healing Logic (always prioritize healing)**
    this.handleHealing(creep, squad);

    // **Step 2: Check if quad is packed**
    if (!this.isQuadPacked(squad)) {
      this.packQuad(creep, squad);
      return;
    }

    // **Step 3: Quad is packed, move as formation**
    this.moveQuadFormation(creep, squad);
  },

  handleHealing(creep, squad) {
    const damaged = _.sortBy(squad.filter(c => c.hits < c.hitsMax), c => c.hits);
    if (damaged.length > 0) {
      const target = creep.pos.findClosestByRange(damaged);
      if (creep.heal(target) === ERR_NOT_IN_RANGE) {
        creep.rangedHeal(target);
      } else {
        creep.heal(target);
      }
    } else if (creep.hits < creep.hitsMax) {
      creep.heal(creep);
    }
  },

  packQuad(creep, squad) {
    // Get or find packing area
    const squadId = creep.memory.squadId;
    if (!Memory.squadPackingAreas) Memory.squadPackingAreas = {};

    let packingArea = Memory.squadPackingAreas[squadId];
    if (!packingArea) {
      const topLeftPos = this.findEmptySquareArea(squad);
      if (!topLeftPos) {
        creep.moveTo(Game.rooms[creep.memory.formRoom].controller);
        return;
      }
      packingArea = { x: topLeftPos.x, y: topLeftPos.y, roomName: topLeftPos.roomName };
      Memory.squadPackingAreas[squadId] = packingArea;
    }

    // Move each creep to its designated position
    const positions = [
      new RoomPosition(packingArea.x, packingArea.y, packingArea.roomName),
      new RoomPosition(packingArea.x + 1, packingArea.y, packingArea.roomName),
      new RoomPosition(packingArea.x, packingArea.y + 1, packingArea.roomName),
      new RoomPosition(packingArea.x + 1, packingArea.y + 1, packingArea.roomName)
    ];

    const targetPos = positions[creep.memory.position];
    if (!creep.pos.isEqualTo(targetPos)) {
      creep.moveTo(targetPos);
    }
  },

  moveQuadFormation(creep, squad) {
    // Find leader (top-left creep)
    const leader = this.getQuadLeader(squad);
    if (!leader) return;

    // Only leader calculates path
    if (creep.id === leader.id) {
      const inAttackRoom = creep.room.name === creep.memory.attackRoom;
      let targetPos;

      if (inAttackRoom) {
        const target = this.getAttackTarget(creep.room);
        if (target) {
          targetPos = target.pos;
          // Attack if in range
          if (creep.attack(target) === ERR_NOT_IN_RANGE) {
            // Will move toward target below
          }
        } else {
          return; // No target found
        }
      } else {
        // Move toward attack room
        const exitDir = Game.map.findExit(creep.room.name, creep.memory.attackRoom);
        if (exitDir === ERR_NO_PATH || exitDir === ERR_INVALID_ARGS) return;
        const exit = creep.pos.findClosestByRange(exitDir);
        targetPos = exit;
      }

      // **Calculate path using transformed cost matrix**
      const costMatrix = this.getQuadCostMatrix(creep.room.name);
      const path = PathFinder.search(
        leader.pos,
        { pos: targetPos, range: 1 },
        {
          plainCost: 1,
          swampCost: 5,
          roomCallback: () => costMatrix,
          maxRooms: 1
        }
      );

      if (path.path.length > 0) {
        const nextPos = path.path[0];
        const direction = leader.pos.getDirectionTo(nextPos);

        // **Move all squad members in the same direction**
        squad.forEach(member => {
          member.move(direction);
        });
      }
    }
  },

  getQuadLeader(squad) {
    // Find top-left creep (leader)
    return _.min(squad, creep => creep.pos.y * 50 + creep.pos.x);
  },

  getQuadCostMatrix(roomName) {
    const room = Game.rooms[roomName];
    if (!room) return new PathFinder.CostMatrix();

    // Create base cost matrix
    const costs = new PathFinder.CostMatrix();

    // Add structure costs
    room.find(FIND_STRUCTURES).forEach(structure => {
      if (structure.structureType === STRUCTURE_ROAD) {
        costs.set(structure.pos.x, structure.pos.y, 1);
      } else if (structure.structureType !== STRUCTURE_CONTAINER && 
                 (structure.structureType !== STRUCTURE_RAMPART || !structure.my)) {
        costs.set(structure.pos.x, structure.pos.y, 255);
      }
    });

    // Add creep costs
    room.find(FIND_CREEPS).forEach(creep => {
      costs.set(creep.pos.x, creep.pos.y, 255);
    });

    // Transform for quad movement
    return this.transformCosts(costs, roomName);
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
