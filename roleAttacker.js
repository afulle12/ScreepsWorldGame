// Attack with auto-selected rally room (closest to target)
//global.orderAttack('E3N44', 5)

// Attack with specific rally room
//global.orderAttack('E3N44', 5, 'E3N45')
const iff = require('iff');

const roleAttacker = {
  /** @param {Creep} creep **/
  run: function(creep) {
    const targetRoom = creep.memory.targetRoom;
    const rallyRoom = creep.memory.rallyRoom;

    // Force new pathfinding if flag is set
    if (creep.memory.forceNewPath) {
      delete creep.memory.forceNewPath;
      console.log(`[Attack] ${creep.name}: Forcing new pathfinding calculation`);
    }

    // Store current room for next tick's previous room tracking
    if (!creep.memory.previousRoom) {
      creep.memory.previousRoom = creep.room.name;
    }

    // Handle retreat state
    if (creep.memory.retreating) {
      return this.handleRetreat(creep);
    }

    // Check for hostile towers in current room (unless it's the target room)
    const shouldAvoidRoom = this.checkForHostileTowers(creep);
    if (shouldAvoidRoom) {
      creep.say('🚨 RETREAT!');

      // Enter retreat mode
      creep.memory.retreating = true;
      creep.memory.retreatTarget = creep.memory.previousRoom || rallyRoom;

      // CRITICAL FIX: Thoroughly clear all movement cache
      this.clearAllMovementCache(creep);

      return this.handleRetreat(creep);
    }

    // Update previous room tracking (only when not retreating)
    if (creep.memory.previousRoom !== creep.room.name) {
      creep.memory.previousRoom = creep.room.name;
    }

    // Phase 1: Move to rally room if not there yet
    if (!creep.memory.rallyComplete && creep.room.name !== rallyRoom) {
      this.moveToAvoidingBlacklist(creep, new RoomPosition(25, 25, rallyRoom), {
        visualizePathStyle: { stroke: '#00ff00', lineStyle: 'dotted' },
        range: 23
      });
      creep.say(`🛡️ ${rallyRoom}`);
      return;
    }

    // Phase 2: Rally in rally room
    if (!creep.memory.rallyComplete && creep.room.name === rallyRoom) {
      const rallyResult = this.handleRallyPhase(creep);
      if (!rallyResult) return; // Still rallying
    }

    // Phase 3: Move to target room - FIXED: Now uses custom avoidance movement
    if (creep.room.name !== targetRoom) {
      this.moveToAvoidingBlacklist(creep, new RoomPosition(25, 25, targetRoom), {
        visualizePathStyle: { stroke: '#ff0000', lineStyle: 'dashed' },
        range: 23
      });
      creep.say(`⚔️ ${targetRoom}`);
      return;
    }

    // Phase 4: Combat logic
    const hasHealParts = creep.body.some(part => part.type === HEAL && part.hits > 0);
    if (hasHealParts && creep.hits < creep.hitsMax) {
      const healResult = creep.heal(creep);
      if (healResult === OK) {
        creep.say('🩹 HEAL');
      }
    }

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
   * Custom moveTo that respects blacklisted rooms
   * @param {Creep} creep 
   * @param {RoomPosition} target 
   * @param {Object} opts 
   */
  moveToAvoidingBlacklist: function(creep, target, opts = {}) {
    // If no blacklisted rooms, use normal moveTo for efficiency
    if (!creep.memory.blacklistedRooms || creep.memory.blacklistedRooms.length === 0) {
      return creep.moveTo(target, opts);
    }

    // Use PathFinder.search directly to ensure our room callback is respected
    const goals = [{ pos: target, range: opts.range || 1 }];

    const result = PathFinder.search(creep.pos, goals, {
      maxOps: opts.maxOps || 4000,
      maxRooms: opts.maxRooms || 16,
      plainCost: opts.plainCost || 1,
      swampCost: opts.swampCost || 5,
      roomCallback: this.getAvoidanceRoomCallback(creep)
    });

    // Debug logging
    if (result.incomplete) {
      console.log(`[Attack] ${creep.name}: PathFinder incomplete, blacklisted: ${JSON.stringify(creep.memory.blacklistedRooms)}`);
    }

    if (result.path && result.path.length > 0) {
      // Move along the calculated path
      const nextStep = result.path[0];
      const direction = creep.pos.getDirectionTo(nextStep);

      // Visualize the path if requested
      if (opts.visualizePathStyle) {
        creep.room.visual.poly(result.path, opts.visualizePathStyle);
      }

      // Additional debug: check if next step would go to blacklisted room
      if (creep.memory.blacklistedRooms.includes(nextStep.roomName)) {
        console.log(`[Attack] ${creep.name}: ERROR - PathFinder trying to go to blacklisted room ${nextStep.roomName}!`);
        return ERR_NO_PATH;
      }

      console.log(`[Attack] ${creep.name}: Moving to ${nextStep}, avoiding ${JSON.stringify(creep.memory.blacklistedRooms)}`);
      return creep.move(direction);
    }

    console.log(`[Attack] ${creep.name}: No path found to ${target}, blacklisted: ${JSON.stringify(creep.memory.blacklistedRooms)}`);
    return ERR_NO_PATH;
  },

  /**
   * Thoroughly clears all cached movement data for a creep
   * @param {Creep} creep 
   */
  clearAllMovementCache: function(creep) {
    // Clear all possible movement cache locations
    delete creep.memory._move;
    delete creep.memory._path;
    delete creep.memory.pathToTarget;
    delete creep.memory.destination;

    // Force immediate recalculation flag
    creep.memory.forceNewPath = true;

    console.log(`[Attack] ${creep.name}: Cleared all movement cache`);
  },

  /**
   * Handles the retreat behavior when towers are detected
   * @param {Creep} creep 
   * @returns {void}
   */
  handleRetreat: function(creep) {
    const targetRoom = creep.memory.targetRoom;
    const rallyRoom = creep.memory.rallyRoom;

    // Phase 1: Get out of the tower room
    if (!creep.memory.retreatTarget) {
      creep.memory.retreatTarget = creep.memory.previousRoom || rallyRoom;
    }

    // If still in a blacklisted room, get out immediately
    if (creep.memory.blacklistedRooms && creep.memory.blacklistedRooms.includes(creep.room.name)) {
      const exitDir = creep.room.findExitTo(creep.memory.retreatTarget);
      if (exitDir !== ERR_NO_PATH && exitDir !== ERR_INVALID_ARGS) {
        const exit = creep.pos.findClosestByPath(exitDir);
        if (exit) {
          creep.moveTo(exit, {
            visualizePathStyle: { stroke: '#ff0000', lineStyle: 'solid' }
          });
          creep.say('🏃 FLEE!');
          return;
        }
      }

      // Fallback: find any exit that doesn't lead to a blacklisted room
      const exits = Game.map.describeExits(creep.room.name);
      for (const direction in exits) {
        const neighborRoom = exits[direction];
        // Don't go to blacklisted rooms
        if (creep.memory.blacklistedRooms && creep.memory.blacklistedRooms.includes(neighborRoom)) {
          continue;
        }

        const exitDir = parseInt(direction);
        const exit = creep.pos.findClosestByPath(exitDir);
        if (exit) {
          creep.moveTo(exit, {
            visualizePathStyle: { stroke: '#ff0000', lineStyle: 'solid' }
          });
          creep.say('🏃 FLEE!');
          return;
        }
      }
      return;
    }

    // Phase 2: Move away from the edge of the safe room
    const distanceFromEdge = Math.min(
      creep.pos.x, 
      creep.pos.y, 
      49 - creep.pos.x, 
      49 - creep.pos.y
    );

    if (distanceFromEdge < 5) {
      // Move toward center of room
      const centerPos = new RoomPosition(25, 25, creep.room.name);
      creep.moveTo(centerPos, {
        visualizePathStyle: { stroke: '#ffaa00', lineStyle: 'dotted' }
      });
      creep.say('🛡️ SAFE');
      return;
    }

    // Phase 3: Heal up if damaged
    const hasHealParts = creep.body.some(part => part.type === HEAL && part.hits > 0);
    if (hasHealParts && creep.hits < creep.hitsMax) {
      creep.heal(creep);
      creep.say('🩹 HEAL');
      return;
    }

    // Phase 4: Wait a few ticks to ensure we're stable, then exit retreat mode
    if (!creep.memory.retreatTimer) {
      creep.memory.retreatTimer = Game.time;
    }

    if (Game.time - creep.memory.retreatTimer > 3) {
      // Clear retreat state
      delete creep.memory.retreating;
      delete creep.memory.retreatTarget;
      delete creep.memory.retreatTimer;

      // CRITICAL FIX: Thoroughly clear all movement cache
      this.clearAllMovementCache(creep);

      creep.say('✅ READY');
      console.log(`[Attack] Creep ${creep.name} finished retreating, blacklisted rooms: ${JSON.stringify(creep.memory.blacklistedRooms)}`);
    } else {
      creep.say(`⏳ ${3 - (Game.time - creep.memory.retreatTimer)}`);
    }
  },

  /**
   * Checks if current room has hostile towers and blacklists it if found
   * @param {Creep} creep 
   * @returns {boolean} true if room should be avoided, false if safe
   */
  checkForHostileTowers: function(creep) {
    // Don't blacklist target room even if it has towers
    if (creep.room.name === creep.memory.targetRoom) {
      return false;
    }

    const towers = creep.room.find(FIND_HOSTILE_STRUCTURES, {
      filter: s => {
        if (s.structureType !== STRUCTURE_TOWER) return false;
        // Check if tower owner is on whitelist
        if (s.owner && iff.IFF_WHITELIST.includes(s.owner.username)) {
          return false;
        }
        return true;
      }
    });

    if (towers.length > 0) {
      // Initialize blacklist if it doesn't exist
      if (!creep.memory.blacklistedRooms) {
        creep.memory.blacklistedRooms = [];
      }

      // Add room to blacklist if not already there
      if (!creep.memory.blacklistedRooms.includes(creep.room.name)) {
        creep.memory.blacklistedRooms.push(creep.room.name);

        // CRITICAL FIX: Thoroughly clear all cached movement data
        this.clearAllMovementCache(creep);

        console.log(`[Attack] Creep ${creep.name} blacklisted room ${creep.room.name} due to hostile towers`);
      }

      return true;
    }

    return false;
  },

  /**
   * Custom room callback that avoids blacklisted rooms
   * @param {Creep} creep 
   * @returns {function} PathFinder room callback
   */
  getAvoidanceRoomCallback: function(creep) {
    return function(roomName) {
      // Block blacklisted rooms (except target room)
      if (creep.memory.blacklistedRooms && 
          creep.memory.blacklistedRooms.includes(roomName) && 
          roomName !== creep.memory.targetRoom) {
        console.log(`[Attack] ${creep.name}: BLOCKING pathfinding through blacklisted room ${roomName}`);
        return false; // This should completely block the room
      }

      // Allow pathfinding through other rooms with normal cost matrix
      const matrix = new PathFinder.CostMatrix();
      const room = Game.rooms[roomName];
      if (room) {
        room.find(FIND_STRUCTURES).forEach(s => {
          if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) {
            matrix.set(s.pos.x, s.pos.y, 255);
          }
        });
      }
      return matrix;
    };
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

    // Move to rally point using custom avoidance movement
    const range = creep.pos.getRangeTo(rallyPoint);
    if (range > 3) {
      this.moveToAvoidingBlacklist(creep, rallyPoint, {
        visualizePathStyle: { stroke: '#00ff00', lineStyle: 'dotted' },
        range: 3
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
