// Source Keeper Room Attacker - Hit and Run Tactics
// Engages keepers, retreats to heal, re-engages until killed.
// Continuous operation: creeps are auto-replaced when they die.
//
// global.orderSKAttack('E3N45', 'E4N45', 1)   -- 1 attacker
// global.orderSKAttack('E3N45', 'E4N45', 2)   -- 2 attackers
// global.cancelSKAttack('E4N45')               -- cancel operation

// ============================================================================
// Console Commands
// ============================================================================

global.orderSKAttack = function(spawnRoom, targetRoom, count) {
  if (!spawnRoom || !targetRoom) {
    return "[SKAttack] Usage: global.orderSKAttack('spawnRoom', 'targetRoom', count)";
  }

  if (!Game.rooms[spawnRoom] || !Game.rooms[spawnRoom].controller || !Game.rooms[spawnRoom].controller.my) {
    return "[SKAttack] Invalid spawn room: " + spawnRoom + ". Must be a room you control.";
  }

  count = count || 1;

  if (!Memory.skAttackOrders) Memory.skAttackOrders = [];

  var existingOrder = Memory.skAttackOrders.find(function(o) {
    return o.targetRoom === targetRoom;
  });
  if (existingOrder) {
    existingOrder.count = count;
    existingOrder.spawnRoom = spawnRoom;
    return "[SKAttack] Updated existing order for " + targetRoom + ": " + count + " attackers from " + spawnRoom;
  }

  Memory.skAttackOrders.push({
    spawnRoom: spawnRoom,
    targetRoom: targetRoom,
    count: count,
    active: true
  });

  console.log("[SKAttack] Order created: " + count + " attacker(s) from " + spawnRoom + " -> " + targetRoom);
  return "[SKAttack] Order created: " + count + " attacker(s) from " + spawnRoom + " -> " + targetRoom;
};

global.cancelSKAttack = function(targetRoom) {
  if (!Memory.skAttackOrders || Memory.skAttackOrders.length === 0) {
    return "[SKAttack] No active orders.";
  }

  var removed = false;
  for (var i = Memory.skAttackOrders.length - 1; i >= 0; i--) {
    if (Memory.skAttackOrders[i].targetRoom === targetRoom) {
      Memory.skAttackOrders.splice(i, 1);
      removed = true;
    }
  }

  if (removed) {
    // Mark existing creeps so they finish up and don't get replaced
    for (var name in Game.creeps) {
      var c = Game.creeps[name];
      if (c.memory && c.memory.role === 'skAttacker' && c.memory.targetRoom === targetRoom) {
        c.memory.noReplace = true;
      }
    }
    return "[SKAttack] Cancelled operation for " + targetRoom + ". Existing creeps will finish their lifespan.";
  }

  return "[SKAttack] No order found for " + targetRoom;
};

// ============================================================================
// Role Logic
// ============================================================================

const roleSKAttacker = {
  // --- Tunable thresholds ---
  RETREAT_HP_RATIO: 0.50,   // Retreat when HP drops below 50%
  REENGAGE_HP_RATIO: 0.90,  // Re-engage when HP recovers above 90%
  FLEE_RANGE: 7,             // Flee to this range from hostiles

  /** @param {Creep} creep **/
  run: function(creep) {
    var targetRoom = creep.memory.targetRoom;

    // Initialize state
    if (!creep.memory.state) creep.memory.state = 'moving';

    // Kill stale movement cache: if _move was calculated from a different
    // room than we're currently in, the path is garbage. This prevents
    // the bounce loop where a cached cross-room path keeps pulling us
    // back and forth across room boundaries.
    if (creep.memory._move && creep.memory._move.room !== creep.room.name) {
      delete creep.memory._move;
    }

    // If standing on a room edge tile, force one step toward center.
    // Without this the creep oscillates: step out -> clear cache -> 
    // recalculate path to edge -> step out again, forever.
    if (creep.pos.x === 0 || creep.pos.x === 49 ||
        creep.pos.y === 0 || creep.pos.y === 49) {
      delete creep.memory._move;
      creep.moveTo(new RoomPosition(25, 25, creep.room.name), {
        maxRooms: 1,
        reusePath: 0
      });
      if (creep.hits < creep.hitsMax) creep.heal(creep);
      return;
    }

    // Always self-heal if damaged and we have heal parts
    this.tryHeal(creep);

    // Health-based state transitions
    this.updateState(creep);

    // Execute current state
    switch (creep.memory.state) {
      case 'moving':
        this.stateMoving(creep);
        break;
      case 'fighting':
        this.stateFighting(creep);
        break;
      case 'retreating':
        this.stateRetreating(creep);
        break;
      case 'waiting':
        this.stateWaiting(creep);
        break;
    }
  },

  // ==========================================================================
  // Self-heal (runs every tick regardless of state)
  // ==========================================================================
  tryHeal: function(creep) {
    if (creep.hits >= creep.hitsMax) return;

    var hasHeal = creep.body.some(function(p) {
      return p.type === HEAL && p.hits > 0;
    });
    if (!hasHeal) return;

    // If we're in melee range of a hostile, attack takes the action slot,
    // so only heal when retreating or not adjacent to a hostile
    if (creep.memory.state === 'retreating' || creep.memory.state === 'waiting' || creep.memory.state === 'moving') {
      creep.heal(creep);
    }
  },

  // ==========================================================================
  // State transitions based on HP
  // ==========================================================================
  updateState: function(creep) {
    var hpRatio = creep.hits / creep.hitsMax;
    var oldState = creep.memory.state;

    // Not in the target room
    if (creep.room.name !== creep.memory.targetRoom) {
      // If we were retreating and got pushed out, stay retreating
      // so we heal up before going back in. Only switch to moving
      // once we're healthy enough to fight.
      if (creep.memory.state === 'retreating') {
        if (hpRatio >= this.REENGAGE_HP_RATIO) {
          creep.memory.state = 'moving';
          delete creep.memory._move; // Clear stale path cache
        }
        // else: stay retreating, self-heal will run, stateRetreating
        // will handle moving back toward center / target room
        return;
      }
      if (creep.memory.state !== 'moving') {
        creep.memory.state = 'moving';
        delete creep.memory._move;
      }
      return;
    }

    // Transition: fighting -> retreating (took too much damage)
    if (creep.memory.state === 'fighting' && hpRatio < this.RETREAT_HP_RATIO) {
      creep.memory.state = 'retreating';
      delete creep.memory._move;
      creep.say('🏃 RETREAT');
      return;
    }

    // Transition: retreating -> fighting (healed up enough)
    if (creep.memory.state === 'retreating' && hpRatio >= this.REENGAGE_HP_RATIO) {
      creep.memory.state = 'fighting';
      delete creep.memory._move;
      delete creep.memory.fleeTarget;
      creep.say('⚔️ CHARGE');
      return;
    }

    // Transition: waiting -> fighting (keeper spawned while we idle)
    if (creep.memory.state === 'waiting') {
      var hostiles = creep.room.find(FIND_HOSTILE_CREEPS);
      if (hostiles.length > 0 && hpRatio >= this.REENGAGE_HP_RATIO) {
        creep.memory.state = 'fighting';
        delete creep.memory._move;
        creep.say('⚔️ FIGHT');
        return;
      }
    }

    // Transition: moving -> fighting (arrived in target room)
    if (creep.memory.state === 'moving' && creep.room.name === creep.memory.targetRoom) {
      delete creep.memory._move;
      // Only enter fighting if healthy enough
      if (hpRatio >= this.REENGAGE_HP_RATIO) {
        creep.memory.state = 'fighting';
        creep.say('⚔️ FIGHT');
      } else {
        creep.memory.state = 'retreating';
        creep.say('🩹 HEAL UP');
      }
      return;
    }
  },

  // ==========================================================================
  // STATE: Moving to target room
  // ==========================================================================
  stateMoving: function(creep) {
    var targetRoom = creep.memory.targetRoom;

    if (creep.room.name === targetRoom) {
      // updateState will handle the transition next tick
      return;
    }

    creep.moveTo(new RoomPosition(25, 25, targetRoom), {
      visualizePathStyle: { stroke: '#ffaa00', lineStyle: 'dashed' },
      range: 20,
      reusePath: 10
    });
    creep.say('🚶 ' + targetRoom);
  },

  // ==========================================================================
  // STATE: Fighting — engage Source Keepers
  // ==========================================================================
  stateFighting: function(creep) {
    // Room guard: if we're not in the target room, switch to moving
    if (creep.room.name !== creep.memory.targetRoom) {
      creep.memory.state = 'moving';
      delete creep.memory._move;
      return;
    }

    var target = this.findTarget(creep);

    if (!target) {
      creep.memory.state = 'waiting';
      delete creep.memory.targetId;
      creep.say('👁️ PATROL');
      return;
    }

    creep.memory.targetId = target.id;

    var attackResult = creep.attack(target);
    if (attackResult === ERR_NOT_IN_RANGE) {
      creep.moveTo(target, {
        visualizePathStyle: { stroke: '#ff0000' },
        reusePath: 3,
        maxRooms: 1
      });
      creep.say('⚔️ CLOSE');

      // Heal while approaching
      if (creep.hits < creep.hitsMax) {
        creep.heal(creep);
      }
    } else if (attackResult === OK) {
      creep.say('💥 ' + Math.round((target.hits / target.hitsMax) * 100) + '%');
      // When in melee range, attack uses the action slot
      // Heal is still possible as a secondary action
      if (creep.hits < creep.hitsMax) {
        creep.heal(creep);
      }
    }
  },

  // ==========================================================================
  // STATE: Retreating — flee from hostiles and self-heal
  // ==========================================================================
  stateRetreating: function(creep) {
    // Self-heal is called in tryHeal() already, but force it here too
    if (creep.hits < creep.hitsMax) {
      creep.heal(creep);
    }

    // If we got pushed out of the target room, move back toward it
    // (updateState keeps us in 'retreating' so we heal on the way)
    if (creep.room.name !== creep.memory.targetRoom) {
      var hpRatio = creep.hits / creep.hitsMax;
      creep.moveTo(new RoomPosition(25, 25, creep.memory.targetRoom), {
        visualizePathStyle: { stroke: '#ffaa00', lineStyle: 'dotted' },
        range: 20,
        reusePath: 5
      });
      creep.say('🩹 ' + Math.round(hpRatio * 100) + '%');
      return;
    }

    // Priority 1: If near a room edge, move toward center first
    // This prevents the bounce loop where we step out and come right back
    var edgeDist = Math.min(
      creep.pos.x,
      creep.pos.y,
      49 - creep.pos.x,
      49 - creep.pos.y
    );

    if (edgeDist < 5) {
      creep.moveTo(new RoomPosition(25, 25, creep.room.name), {
        visualizePathStyle: { stroke: '#ffaa00', lineStyle: 'dotted' },
        maxRooms: 1,
        reusePath: 1
      });
      var hpRatio = creep.hits / creep.hitsMax;
      creep.say('🛡️ ' + Math.round(hpRatio * 100) + '%');
      return;
    }

    // Priority 2: Flee from hostiles toward center of room
    var hostiles = creep.room.find(FIND_HOSTILE_CREEPS);

    if (hostiles.length === 0) {
      // Nothing to flee from, just heal up
      var hpRatio = creep.hits / creep.hitsMax;
      creep.say('🩹 ' + Math.round(hpRatio * 100) + '%');
      return;
    }

    // Use PathFinder.search with flee: true to run away from all hostiles
    var goals = hostiles.map(function(hostile) {
      return { pos: hostile.pos, range: 7 };
    });

    var result = PathFinder.search(creep.pos, goals, {
      flee: true,
      maxRooms: 1,   // Stay in the room — don't flee into another SK room
      plainCost: 1,
      swampCost: 5,
      roomCallback: function(roomName) {
        var room = Game.rooms[roomName];
        if (!room) return new PathFinder.CostMatrix();

        var matrix = new PathFinder.CostMatrix();

        // Block walls and ramparts
        room.find(FIND_STRUCTURES).forEach(function(s) {
          if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) {
            matrix.set(s.pos.x, s.pos.y, 255);
          }
        });

        // Make room edges very expensive to prevent fleeing out
        for (var i = 0; i < 50; i++) {
          matrix.set(i, 0, 200);   // top edge
          matrix.set(i, 49, 200);  // bottom edge
          matrix.set(0, i, 200);   // left edge
          matrix.set(49, i, 200);  // right edge
        }
        // Second row of tiles also costly to give a buffer
        for (var j = 1; j < 49; j++) {
          matrix.set(j, 1, 50);
          matrix.set(j, 48, 50);
          matrix.set(1, j, 50);
          matrix.set(48, j, 50);
        }

        return matrix;
      }
    });

    if (result.path && result.path.length > 0) {
      var nextStep = result.path[0];

      // Safety check: don't step out of the room
      if (nextStep.roomName !== creep.room.name) {
        creep.moveTo(new RoomPosition(25, 25, creep.room.name), {
          maxRooms: 1,
          reusePath: 1
        });
      } else {
        creep.move(creep.pos.getDirectionTo(nextStep));
      }
    }

    var hpRatio = creep.hits / creep.hitsMax;
    creep.say('🩹 ' + Math.round(hpRatio * 100) + '%');
  },

  // ==========================================================================
  // STATE: Waiting — no keepers alive, patrol near lairs
  // ==========================================================================
  stateWaiting: function(creep) {
    // Room guard: if we're not in the target room, switch to moving
    if (creep.room.name !== creep.memory.targetRoom) {
      creep.memory.state = 'moving';
      delete creep.memory._move;
      return;
    }

    // Check if a new keeper has spawned
    var keeper = this.findTarget(creep);
    if (keeper) {
      creep.memory.state = 'fighting';
      creep.say('⚔️ FIGHT');
      return;
    }

    // Find the lair that will spawn soonest
    var lairs = creep.room.find(FIND_HOSTILE_STRUCTURES, {
      filter: function(s) {
        return s.structureType === STRUCTURE_KEEPER_LAIR;
      }
    });

    if (lairs.length === 0) {
      creep.say('❓ NO LAIRS');
      return;
    }

    // Find the lair with the shortest ticksToSpawn
    var nextLair = null;
    var shortestTicks = Infinity;
    for (var i = 0; i < lairs.length; i++) {
      var tts = lairs[i].ticksToSpawn;
      if (tts !== undefined && tts !== null && tts < shortestTicks) {
        shortestTicks = tts;
        nextLair = lairs[i];
      }
    }

    // If no lair has ticksToSpawn set, just pick the closest one
    if (!nextLair) {
      nextLair = creep.pos.findClosestByRange(lairs);
    }

    if (nextLair) {
      // Position near the lair (range 3) so we're ready when it spawns
      var range = creep.pos.getRangeTo(nextLair);
      if (range > 4) {
        creep.moveTo(nextLair, {
          visualizePathStyle: { stroke: '#00ff00', lineStyle: 'dotted' },
          range: 3,
          maxRooms: 1,
          reusePath: 5
        });
      }

      if (shortestTicks < Infinity) {
        creep.say('⏳ ' + shortestTicks);
      } else {
        creep.say('👁️ WAIT');
      }
    }

    // Keep healing if damaged
    if (creep.hits < creep.hitsMax) {
      creep.heal(creep);
    }
  },

  // ==========================================================================
  // Target selection — prioritize Source Keepers
  // ==========================================================================
  findTarget: function(creep) {
    // Priority 1: Check cached target (revalidate every 3 ticks)
    if (creep.memory.targetId && Game.time % 3 !== 0) {
      var cached = Game.getObjectById(creep.memory.targetId);
      if (cached && cached.pos && cached.pos.roomName === creep.room.name) {
        return cached;
      }
      delete creep.memory.targetId;
    }

    // Priority 2: Source Keepers (hostile creeps owned by "Source Keeper")
    var keepers = creep.room.find(FIND_HOSTILE_CREEPS, {
      filter: function(c) {
        return c.owner.username === 'Source Keeper';
      }
    });

    if (keepers.length > 0) {
      // Target the weakest keeper first (already damaged from a previous fight)
      var weakest = keepers.reduce(function(best, k) {
        return k.hits < best.hits ? k : best;
      }, keepers[0]);
      return weakest;
    }

    // Priority 3: Invader creeps that might also be in the room
    var invaders = creep.room.find(FIND_HOSTILE_CREEPS, {
      filter: function(c) {
        return c.owner.username === 'Invader';
      }
    });

    if (invaders.length > 0) {
      return creep.pos.findClosestByRange(invaders);
    }

    return null;
  }
};

module.exports = roleSKAttacker;