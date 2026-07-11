// LLM: Read llmcontext.js before reviewing or changing this file.
// Spawn and rally attackers in spawnRoom, then send them to targetRoom
//
// Console commands:
//
//   orderAttack(spawnRoom, targetRoom, count, ...flags)
//     Spawn `count` attackers in spawnRoom, rally them there, then attack targetRoom.
//     Flags (optional, any order):
//       'sustain' — keep `count` attackers alive indefinitely: replacements spawn as
//                   creeps die and travel straight to the target (no group rally).
//                   Runs until cancelAttackOrder() — there is no automatic stop.
//       'fast'    — use the fastAttacker body instead of the standard attacker body.
//     orderAttack('E3N45', 'E3N44', 5)                     // one-shot wave of 5
//     orderAttack('E3N45', 'E3N44', 3, 'sustain')          // maintain 3 until cancelled
//     orderAttack('E3N45', 'E3N44', 5, 'sustain', 'fast')  // sustained, fast bodies
//
//   cancelAttackOrder(targetRoom)
//     Remove the attack order for targetRoom. For sustained orders this stops
//     respawning; living attackers keep fighting until they die.
//     cancelAttackOrder('E3N44')
//
//   setAttackCount(targetRoom, count)
//     Update the maintained attacker count for an existing sustained attack.
//     Living attackers above the new count keep fighting; replacements pause
//     until the live count drops below the new count.
//     setAttackCount('E3N44', 5)
//
//   assignAttackTarget(roomName, targetId)
//     Point every attacker whose targetRoom is roomName at a specific structure/creep id.
//     assignAttackTarget('E3N44', '5f4e...')
//
// Orders live in Memory.attackOrders; spawning is handled by manageAttackerSpawns()
// in spawnManager.js (runs every 5 ticks).
const iff = require('iff');
const getRoomState = require('getRoomState');
const navigationCache = {
  tick: -1,
  restrictedTiles: {},
  restrictedCoordinates: {},
  structureMatrices: {},
  hostileTowers: {},
  avoidancePaths: {}
};

// ============================================================================
// Console Command
// ============================================================================

global.orderAttack = function(spawnRoom, targetRoom, count) {
  if (!spawnRoom || !targetRoom || !count || count <= 0) {
    return "[Attack] Usage: global.orderAttack('spawnRoom', 'targetRoom', count, 'sustain'?, 'fast'?)";
  }

  var flags = Array.prototype.slice.call(arguments, 3);
  var validFlags = ['sustain', 'fast'];
  var badFlags = flags.filter(function(f){ return validFlags.indexOf(f) === -1; });
  if (badFlags.length > 0) {
    return "[Attack] Unknown flag(s): " + badFlags.join(', ') + ". Valid flags: 'sustain', 'fast'.";
  }
  var sustain = flags.indexOf('sustain') !== -1;
  var fast = flags.indexOf('fast') !== -1;

  if (!Game.rooms[spawnRoom] || !Game.rooms[spawnRoom].controller || !Game.rooms[spawnRoom].controller.my) {
    return "[Attack] Invalid spawn room: " + spawnRoom + ". Must be a room you control.";
  }

  if (!Memory.attackOrders) Memory.attackOrders = [];

  var existingOrder = Memory.attackOrders.find(function(o){
  return o.targetRoom === targetRoom &&
         (o.rallyPhase === 'spawning' || o.rallyPhase === 'rallying');
  });
  if (existingOrder) {
    return "[Attack] Attack order for " + targetRoom + " already exists and is still forming (phase: " + existingOrder.rallyPhase + "). Wait until it reaches the attacking phase.";
  }

  Memory.attackOrders.push({
    targetRoom: targetRoom,
    spawnRoom: spawnRoom,
    rallyRoom: spawnRoom,
    count: count,
    spawned: 0,
    startTime: Game.time,
    rallyPoint: { x: 25, y: 25 },
    rallyPhase: 'spawning',
    sustain: sustain,
    fast: fast
  });

  var desc = "[Attack] Order created: " + count + " attackers spawning in " + spawnRoom + " -> " + targetRoom +
    (sustain ? " [sustained]" : "") + (fast ? " [fast]" : "");
  console.log(desc);
  return desc;
};

const roleAttacker = {
  /** @param {Creep} creep **/
run: function(creep) {
    const targetRoom = creep.memory.targetRoom;
    const rallyRoom = creep.memory.rallyRoom;

    if (creep.memory._path || creep.memory.pathToTarget || creep.memory.destination) {
      delete creep.memory._path;
      delete creep.memory.pathToTarget;
      delete creep.memory.destination;
    }

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
      this.moveSafely(creep, new RoomPosition(25, 25, rallyRoom), {
        visualizePathStyle: { stroke: '#00ff00', lineStyle: 'dotted' },
        range: 23
      });
      return;
    }

    // Phase 2: Rally in rally room
    if (!creep.memory.rallyComplete && creep.room.name === rallyRoom) {
      const rallyResult = this.handleRallyPhase(creep);
      if (!rallyResult) return; // Still rallying
    }

    // Phase 3: Move to target room
    if (creep.room.name !== targetRoom) {
      this.moveSafely(creep, new RoomPosition(25, 25, targetRoom), {
        visualizePathStyle: { stroke: '#ff0000', lineStyle: 'dashed' },
        range: 23
      });
      return;
    }

    // Phase 4: Combat logic
    const hasHealParts = creep.body.some(part => part.type === HEAL && part.hits > 0);
    if (hasHealParts && creep.hits < creep.hitsMax) {
      creep.heal(creep);
    }

    let target = null;
    if (creep.memory.assignedTargetId) {
      target = Game.getObjectById(creep.memory.assignedTargetId);
      if (target && target.structureType === STRUCTURE_POWER_BANK) target = null;
      if (!target) delete creep.memory.assignedTargetId;
      if (target) {
        creep.memory.targetId = target.id;
        creep.say('💥 ATTACK!');
        if (creep.attack(target) === ERR_NOT_IN_RANGE) {
          this.moveSafely(creep, target, { visualizePathStyle: { stroke: '#ff0000' } });
        }
        return;
      }
    }

    if (!target && creep.memory.targetId) {
      target = Game.getObjectById(creep.memory.targetId);
      if (target && target.structureType === STRUCTURE_POWER_BANK) {
        target = null;
        delete creep.memory.targetId;
      }
      if (target) {
        creep.say('💥 ATTACK!');
        const err = creep.attack(target);
        if (err === ERR_NOT_IN_RANGE) {
          this.moveSafely(creep, target, { visualizePathStyle: { stroke: '#ff0000' } });
        }
        return;
      } else {
        delete creep.memory.targetId;
      }
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
            s.structureType === STRUCTURE_KEEPER_LAIR ||
            s.structureType === STRUCTURE_POWER_BANK
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

    if (!target && hasHealParts) {
      const healTarget = this.findDamagedFriendly(creep);
      if (healTarget) {
        delete creep.memory.targetId;
        const range = creep.pos.getRangeTo(healTarget);
        if (creep.hits === creep.hitsMax && range <= 3) {
          if (range <= 1) creep.heal(healTarget);
          else creep.rangedHeal(healTarget);
        }
        if (range > 3 || this.isRestrictedTile(creep, creep.pos.x, creep.pos.y, creep.room.name)) {
          this.moveSafely(creep, healTarget, {
            range: 3,
            visualizePathStyle: { stroke: '#00ff88' }
          });
        }
        return;
      }
    }

    if (target && !creep.pos.inRangeTo(target, 1)) {
      const standardPathRes = PathFinder.search(
        creep.pos, { pos: target.pos, range: 1 },
        {
          maxOps: 1000,
          maxRooms: 1,
          plainCost: 1,
          swampCost: 5,
          roomCallback: roomName => this.getStructureMatrix(roomName, 255)
        }
      );

      if (standardPathRes.incomplete) {
        const wallPathRes = PathFinder.search(
          creep.pos, { pos: target.pos, range: 1 },
          {
            maxOps: 1000,
            maxRooms: 1,
            plainCost: 1,
            swampCost: 5,
            roomCallback: roomName => this.getStructureMatrix(roomName, 1)
          }
        );

        const blockers = [];
        for (const step of wallPathRes.path) {
          const room = Game.rooms[step.roomName];
          const structs = room ? room.lookForAt(LOOK_STRUCTURES, step.x, step.y) : [];
          for (const s of structs) {
            if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) {
              blockers.push(s);
            }
          }
        }

        // Do not bust walls/ramparts in owned or friendly rooms
        const isOwnedOrFriendly = creep.room.controller && (
          creep.room.controller.my ||
          (creep.room.controller.owner && iff.IFF_WHITELIST.includes(creep.room.controller.owner.username))
        );

        if (blockers.length && !isOwnedOrFriendly) {
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
        this.moveSafely(creep, target, { visualizePathStyle: { stroke: '#ff0000' } });
      }
      return;
    }

    // Do not bust walls/ramparts in owned or friendly rooms
    const isFriendlyOrOwnedRoom = creep.room.controller && (
      creep.room.controller.my ||
      (creep.room.controller.owner && iff.IFF_WHITELIST.includes(creep.room.controller.owner.username))
    );

    const allBarriers = creep.room.find(FIND_STRUCTURES, {
      filter: s =>
        s.structureType === STRUCTURE_WALL ||
        s.structureType === STRUCTURE_RAMPART
    });

    if (allBarriers.length && !isFriendlyOrOwnedRoom) {
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
          this.moveSafely(creep, wallTarget, {
            visualizePathStyle: { stroke: '#ffaa00' }
          });
        }
        return;
      }
    }

    if (!creep.room.controller || !creep.room.controller.my) {
      const friendlyBot = creep.pos.findClosestByRange(FIND_MY_CREEPS, {
        filter: c => c.name !== creep.name
      });
      const lastIdlePos = creep.memory.lastIdlePos;
      const isNotMoving = lastIdlePos &&
        lastIdlePos.x === creep.pos.x &&
        lastIdlePos.y === creep.pos.y &&
        lastIdlePos.roomName === creep.room.name;

      creep.memory.lastIdlePos = {
        x: creep.pos.x,
        y: creep.pos.y,
        roomName: creep.room.name
      };

      if (friendlyBot && isNotMoving && !creep.pos.inRangeTo(friendlyBot, 5)) {
        this.moveSafely(creep, friendlyBot, {
          range: 5,
          visualizePathStyle: { stroke: '#00ffff' }
        });
        return;
      }
    } else {
      delete creep.memory.lastIdlePos;
    }

    delete creep.memory.targetId;
  },

  /**
   * Finds the closest damaged friendly creep (own or IFF-whitelisted)
   * @param {Creep} creep
   * @returns {Creep|null}
   */
  findDamagedFriendly: function(creep) {
    const state = getRoomState.get(creep.room.name);
    if (!state) return null;
    const damaged = state.myCreeps.filter(c => c.id !== creep.id && c.hits < c.hitsMax);
    for (const c of state.hostiles) {
      if (c.hits < c.hitsMax && iff.isWhitelistedCreep(c)) damaged.push(c);
    }
    if (damaged.length === 0) return null;
    return creep.pos.findClosestByRange(damaged);
  },

  /**
   * Collects tiles reserved by tower-drain lanes in a room, keyed "x,y"
   * @param {string} roomName
   * @returns {Object}
   */
  getTowerDrainReservedTiles: function(roomName) {
    const cache = this.getNavigationCache();
    const cacheKey = 'base:' + roomName;
    if (cache.restrictedTiles[cacheKey]) return cache.restrictedTiles[cacheKey];

    const reserved = {};
    if (Memory.towerDrainOps && Memory.towerDrainOps.operations) {
      const ops = Memory.towerDrainOps.operations;
      for (const opKey in ops) {
        const lanes = ops[opKey].lanes;
        if (!lanes) continue;
        for (const laneKey in lanes) {
          const lane = lanes[laneKey];
          const positions = [lane.attackEdgePos, lane.attackRestPos, lane.healEdgePos, lane.healRestPos];
          for (const p of positions) {
            if (p && p.roomName === roomName) reserved[p.x + ',' + p.y] = true;
          }
        }
      }
    }

    const allCreeps = getRoomState.creepIndex().all;
    for (const c of allCreeps) {
      if (!c.memory || c.memory.role !== 'drainDemolisher' || !c.memory.healerParkPos) continue;
      const p = c.memory.healerParkPos;
      if (p.roomName === roomName) reserved[p.x + ',' + p.y] = true;
    }

    cache.restrictedTiles[cacheKey] = reserved;
    return reserved;
  },

  /**
   * @param {Creep} creep
   * @param {string} roomName
   * @returns {Object}
   */
  getRestrictedTiles: function(creep, roomName) {
    const cache = this.getNavigationCache();
    const isTargetRoom = roomName === creep.memory.targetRoom;
    const cacheKey = roomName + ':' + isTargetRoom;
    if (cache.restrictedTiles[cacheKey]) return cache.restrictedTiles[cacheKey];

    const restricted = Object.assign({}, this.getTowerDrainReservedTiles(roomName));

    if (isTargetRoom) {
      for (let i = 0; i <= 49; i++) {
        restricted[i + ',0'] = true;
        restricted[i + ',49'] = true;
        restricted['0,' + i] = true;
        restricted['49,' + i] = true;
      }
    }

    cache.restrictedTiles[cacheKey] = restricted;
    return restricted;
  },

  getRestrictedTileCoordinates: function(creep, roomName) {
    const cache = this.getNavigationCache();
    const cacheKey = roomName + ':' + (roomName === creep.memory.targetRoom);
    if (!cache.restrictedCoordinates[cacheKey]) {
      cache.restrictedCoordinates[cacheKey] = Object.keys(this.getRestrictedTiles(creep, roomName)).map(key => {
        const xy = key.split(',');
        return { x: Number(xy[0]), y: Number(xy[1]) };
      });
    }
    return cache.restrictedCoordinates[cacheKey];
  },

  getNavigationCache: function() {
    if (navigationCache.tick !== Game.time) {
      navigationCache.tick = Game.time;
      navigationCache.restrictedTiles = {};
      navigationCache.restrictedCoordinates = {};
      navigationCache.structureMatrices = {};
      navigationCache.hostileTowers = {};
    }
    return navigationCache;
  },

  getStructureMatrix: function(roomName, wallCost) {
    const cache = this.getNavigationCache();
    const cacheKey = roomName + ':' + wallCost;
    if (!cache.structureMatrices[cacheKey]) {
      const matrix = new PathFinder.CostMatrix();
      const room = Game.rooms[roomName];
      if (room) {
        room.find(FIND_STRUCTURES).forEach(s => {
          if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) {
            matrix.set(s.pos.x, s.pos.y, wallCost);
          }
        });
      }
      cache.structureMatrices[cacheKey] = matrix;
    }
    return cache.structureMatrices[cacheKey].clone();
  },

  applyRestrictedTiles: function(matrix, creep, roomName) {
    for (const pos of this.getRestrictedTileCoordinates(creep, roomName)) {
      matrix.set(pos.x, pos.y, 255);
    }
    return matrix;
  },

  /**
   * @param {Creep} creep
   * @param {number} x
   * @param {number} y
   * @param {string} roomName
   * @returns {boolean}
   */
  isRestrictedTile: function(creep, x, y, roomName) {
    return !!this.getRestrictedTiles(creep, roomName)[x + ',' + y];
  },

  /**
   * Central movement entry point for attackers. This is the only attacker helper
   * that may call Creep.move or Creep.moveTo.
   * @param {Creep} creep
   * @param {RoomObject|RoomPosition} target
   * @param {Object} opts
   */
  moveSafely: function(creep, target, opts = {}) {
    const currentRestricted = this.getRestrictedTiles(creep, creep.room.name);
    if (currentRestricted[creep.pos.x + ',' + creep.pos.y]) {
      const terrain = creep.room.getTerrain();
      let best = null;

      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const nx = creep.pos.x + dx;
          const ny = creep.pos.y + dy;
          if (nx < 1 || nx > 48 || ny < 1 || ny > 48) continue;
          if (currentRestricted[nx + ',' + ny]) continue;
          if (terrain.get(nx, ny) === TERRAIN_MASK_WALL) continue;
          if (creep.room.lookForAt(LOOK_CREEPS, nx, ny).length > 0) continue;
          best = { x: nx, y: ny };
          break;
        }
        if (best) break;
      }

      if (best) {
        return creep.move(creep.pos.getDirectionTo(best.x, best.y));
      }
    }

    const baseCostCallback = opts.costCallback;
    const moveOpts = Object.assign({}, opts);
    const targetPos = target.pos || target;
    if (moveOpts.reusePath === undefined) moveOpts.reusePath = 10;
    moveOpts.costCallback = (roomName, matrix) => {
      if (baseCostCallback) baseCostCallback(roomName, matrix);
      this.applyRestrictedTiles(matrix, creep, roomName);
    };

    if (!creep.memory.blacklistedRooms || creep.memory.blacklistedRooms.length === 0) {
      return creep.moveTo(target, moveOpts);
    }

    const cache = this.getNavigationCache();
    const blacklist = creep.memory.blacklistedRooms.join(',');
    const pathKey = targetPos.roomName + ':' + targetPos.x + ':' + targetPos.y + ':' + (moveOpts.range || 1) + ':' + blacklist;
    let cachedPath = cache.avoidancePaths[creep.name];
    if (!cachedPath || cachedPath.key !== pathKey) {
      cachedPath = null;
    } else if (cachedPath.path.length && creep.pos.isEqualTo(cachedPath.path[0])) {
      cachedPath.path.shift();
    }

    if (cachedPath && cachedPath.path.length) {
      const nextStep = cachedPath.path[0];
      if (!creep.memory.blacklistedRooms.includes(nextStep.roomName)) {
        return creep.move(creep.pos.getDirectionTo(nextStep));
      }
      delete cache.avoidancePaths[creep.name];
    }

    const goals = [{ pos: targetPos, range: moveOpts.range || 1 }];
    const result = PathFinder.search(creep.pos, goals, {
      maxOps: moveOpts.maxOps || 4000,
      maxRooms: moveOpts.maxRooms || 16,
      plainCost: moveOpts.plainCost || 1,
      swampCost: moveOpts.swampCost || 5,
      roomCallback: this.getAvoidanceRoomCallback(creep)
    });

    if (result.path && result.path.length > 0) {
      cache.avoidancePaths[creep.name] = { key: pathKey, path: result.path };
      const nextStep = result.path[0];
      const direction = creep.pos.getDirectionTo(nextStep);

      if (moveOpts.visualizePathStyle) {
        creep.room.visual.poly(result.path, moveOpts.visualizePathStyle);
      }

      if (creep.memory.blacklistedRooms.includes(nextStep.roomName)) {
        console.log(`[Attack] ${creep.name}: ERROR - PathFinder trying to go to blacklisted room ${nextStep.roomName}!`);
        return ERR_NO_PATH;
      }

      return creep.move(direction);
    }

    if (result.incomplete && Game.time % 25 === 0) {
      console.log(`[Attack] ${creep.name}: No complete path while avoiding ${blacklist}`);
    }
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
    delete navigationCache.avoidancePaths[creep.name];

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
          this.moveSafely(creep, exit, {
            visualizePathStyle: { stroke: '#ff0000', lineStyle: 'solid' }
          });
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
          this.moveSafely(creep, exit, {
            visualizePathStyle: { stroke: '#ff0000', lineStyle: 'solid' }
          });
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

    if (distanceFromEdge < 2) {
      const centerPos = new RoomPosition(25, 25, creep.room.name);
      this.moveSafely(creep, centerPos, {
        visualizePathStyle: { stroke: '#ffaa00', lineStyle: 'dotted' }
      });
      return;
    }

    // Phase 3: Heal up if damaged
    const hasHealParts = creep.body.some(part => part.type === HEAL && part.hits > 0);
    if (hasHealParts && creep.hits < creep.hitsMax) {
      creep.heal(creep);
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

      console.log(`[Attack] Creep ${creep.name} finished retreating, blacklisted rooms: ${JSON.stringify(creep.memory.blacklistedRooms)}`);
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

    const cache = this.getNavigationCache();
    let towers = cache.hostileTowers[creep.room.name];
    if (!towers) {
      towers = creep.room.find(FIND_HOSTILE_STRUCTURES, {
        filter: s => {
          if (s.structureType !== STRUCTURE_TOWER) return false;
          return !s.owner || !iff.IFF_WHITELIST.includes(s.owner.username);
        }
      });
      cache.hostileTowers[creep.room.name] = towers;
    }

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
    const self = this;
    return function(roomName) {
      // Block blacklisted rooms (except target room)
      if (creep.memory.blacklistedRooms && 
          creep.memory.blacklistedRooms.includes(roomName) && 
          roomName !== creep.memory.targetRoom) {
        return false;
      }

      return self.applyRestrictedTiles(self.getStructureMatrix(roomName, 255), creep, roomName);
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
      this.moveSafely(creep, rallyPoint, {
        visualizePathStyle: { stroke: '#00ff00', lineStyle: 'dotted' },
        range: 3
      });
    }

    return false; // Still rallying
  }
};
module.exports = roleAttacker;

global.assignAttackTarget = function(roomName, targetId) {
  if (!roomName || !targetId) {
    return "[Attack] Invalid command. Use global.assignAttackTarget('roomName', 'targetId').";
  }
  var attackersInRoom = _.filter(getRoomState.creepIndex().all, function(c){
    return c.memory.role === 'attacker' && c.memory.targetRoom === roomName;
  });
  if (attackersInRoom.length === 0) {
    return "[Attack] No attackers found for room " + roomName + ".";
  }
  var assignedCount = 0;
  for (var i = 0; i < attackersInRoom.length; i++) {
    var creep = attackersInRoom[i];
    creep.memory.assignedTargetId = targetId;
    assignedCount++;
  }
  return "[Attack] Assigned target " + targetId + " to " + assignedCount + " attackers in room " + roomName + ".";
};

global.cancelAttackOrder = function (targetRoom) {
  if (!Memory.attackOrders || Memory.attackOrders.length === 0) return '[Attack] No active attack orders.';
  var i = Memory.attackOrders.findIndex(function(o){ return o.targetRoom === targetRoom; });
  if (i === -1) return "[Attack] No attack order found for " + targetRoom + ".";
  var wasSustained = Memory.attackOrders[i].sustain === true;
  Memory.attackOrders.splice(i, 1);
  return "[Attack] Attack on " + targetRoom + " has been cancelled." +
    (wasSustained ? " Respawning stopped; living attackers will fight until they die." : "");
};

global.setAttackCount = function(targetRoom, count) {
  count = parseInt(count, 10);
  if (!targetRoom || !count || count < 1) {
    return "[Attack] Invalid command. Use global.setAttackCount('targetRoom', count).";
  }
  if (!Memory.attackOrders || Memory.attackOrders.length === 0) return '[Attack] No active attack orders.';

  var i = Memory.attackOrders.findIndex(function(o){ return o.targetRoom === targetRoom; });
  if (i === -1) return "[Attack] No attack order found for " + targetRoom + ".";

  var order = Memory.attackOrders[i];
  if (order.sustain !== true) {
    return "[Attack] Attack order for " + targetRoom + " is not sustained; count updates only apply to sustained attacks.";
  }

  var oldCount = order.count || 0;
  order.count = count;

  var alive = _.filter(getRoomState.creepIndex().all, function(c){
    return c.memory.role === 'attacker' && c.memory.targetRoom === targetRoom;
  }).length;

  return "[Attack] Updated sustained attack on " + targetRoom + " count " + oldCount + " -> " + count +
    ". Currently alive: " + alive + "/" + count + "." +
    (alive > count ? " Extra attackers will keep fighting; replacements are paused until losses occur." : "");
};
