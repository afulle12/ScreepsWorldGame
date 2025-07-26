// === PROFILER INTEGRATION ===
const profiler = require('screeps-profiler');

// Enable profiling - you can toggle this on/off
profiler.enable();

// === CPU USAGE LOGGING TOGGLE VARIABLES ===
const ENABLE_CPU_LOGGING = false;
const DISABLE_CPU_CONSOLE = true;

// --- ROLE & UTILITY IMPORTS ---
const roleHarvester = require('roleHarvester');
const roleUpgrader = require('roleUpgrader');
const roleBuilder = require('roleBuilder');
const roleScout = require('roleScout');
const roleDefender = require('roleDefender');
const roleSupplier = require('roleSupplier');
const roleClaimbot = require('roleClaimbot');
// const roleRemoteHarvester = require('roleRemoteHarvesters'); // disabled per request
const roleAttacker = require('roleAttacker');
const roleExtractor = require('roleExtractor');
const iff = require('iff');
const roleScavenger = require('roleScavenger');
const roleThief = require('roleThief');
const squad = require('squadModule');
const roleTowerDrain = require('roleTowerDrain');
const roleDemolition = require('roleDemolition');

// Register modules with profiler
profiler.registerObject(roleHarvester, 'roleHarvester');
profiler.registerObject(roleUpgrader, 'roleUpgrader');
profiler.registerObject(roleBuilder, 'roleBuilder');
profiler.registerObject(roleScout, 'roleScout');
profiler.registerObject(roleDefender, 'roleDefender');
profiler.registerObject(roleSupplier, 'roleSupplier');
profiler.registerObject(roleClaimbot, 'roleClaimbot');
profiler.registerObject(roleAttacker, 'roleAttacker');
profiler.registerObject(roleExtractor, 'roleExtractor');
profiler.registerObject(iff, 'iff');
profiler.registerObject(roleScavenger, 'roleScavenger');
profiler.registerObject(roleThief, 'roleThief');
profiler.registerObject(squad, 'squad');
profiler.registerObject(roleTowerDrain, 'roleTowerDrain');
profiler.registerObject(roleDemolition, 'roleDemolition');

// --- CONSTANTS ---
const BASIC_HARVESTER = [WORK, WORK, CARRY, MOVE];
const BASIC_DEFENDER   = [TOUGH, MOVE, RANGED_ATTACK];
const SCOUT_BODY       = [MOVE, MOVE, MOVE, MOVE, MOVE];
const SCAVENGER_BODY = [MOVE, CARRY, CARRY, MOVE];
const TOWER_DRAIN_BODY = [TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, HEAL, HEAL, HEAL, HEAL, MOVE];

const MAX_REMOTE_SOURCES_PER_ROOM = 3;

const PRIORITIES = [
  {
    type: 'repair',
    filter: s =>
      (s.structureType !== STRUCTURE_CONTAINER &&
       s.structureType !== STRUCTURE_WALL &&
       s.structureType !== STRUCTURE_RAMPART) &&
      (s.hits / s.hitsMax < 0.25) &&
      s.hits < s.hitsMax,
    label: 'Repair <25%',
    need: s => `${s.hits}/${s.hitsMax}`,
    urgency: s => s.hits,
  },
  {
    type: 'build',
    filter: s => true,
    targetFinder: room => room.find(FIND_CONSTRUCTION_SITES),
    label: 'Build',
    need: s => `${s.progress}/${s.progressTotal}`,
    urgency: s => -s.progress,
  },
  {
    type: 'repair',
    filter: s =>
      s.structureType === STRUCTURE_CONTAINER &&
      s.hits / s.hitsMax < 0.75 &&
      s.hits < s.hitsMax,
    label: 'Repair Container <75%',
    need: s => `${s.hits}/${s.hitsMax}`,
    urgency: s => s.hits,
  },
  {
    type: 'repair',
    filter: s =>
      s.structureType === STRUCTURE_ROAD &&
      (s.hits / s.hitsMax < 0.75) &&
      (s.hits / s.hitsMax >= 0.25) &&
      s.hits < s.hitsMax,
    label: 'Repair Road <75%',
    need: s => `${s.hits}/${s.hitsMax}`,
    urgency: s => s.hits,
  },
  {
    type: 'repair',
    filter: s =>
      ![STRUCTURE_ROAD, STRUCTURE_CONTAINER].includes(s.structureType) &&
      (s.hits / s.hitsMax < 0.75) &&
      (s.hits / s.hitsMax >= 0.25) &&
      s.hits < s.hitsMax,
    label: 'Repair Other <75%',
    need: s => `${s.hits}/${s.hitsMax}`,
    urgency: s => s.hits,
  },
  {
    type: 'collect',
    filter: r => r.amount > 50,
    targetFinder: room => room.find(FIND_DROPPED_RESOURCES, { filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > 50 }),
    label: 'Collect >50',
    need: r => `${r.amount}`,
    urgency: r => -r.amount,
  },
];

// =================================================================
// === ALL HELPER FUNCTIONS & CONSOLE COMMANDS ARE DEFINED HERE ===
// =================================================================

// --- CONSOLE COMMANDS ---
global.orderThieves = function(homeRoom, targetRoom, count) {
    if (!Game.rooms[homeRoom] || !Game.rooms[homeRoom].controller || !Game.rooms[homeRoom].controller.my) {
        return `[Thief] Invalid home room: ${homeRoom}. Must be a room you own.`;
    }
    if (!targetRoom || !count || count <= 0) {
        return `[Thief] Invalid order. Use: orderThieves('homeRoomName', 'targetRoomName', creepCount)`;
    }
    if (!Memory.thiefOrders) {
        Memory.thiefOrders = [];
    }
    const existingOrder = Memory.thiefOrders.find(o => o.targetRoom === targetRoom);
    if (existingOrder) {
        return `[Thief] An operation against ${targetRoom} is already active. Cancel it first to create a new one.`;
    }

    Memory.thiefOrders.push({
        homeRoom: homeRoom,
        targetRoom: targetRoom,
        count: parseInt(count, 10)
    });
    return `[Thief] Order placed for ${count} thieves to raid ${targetRoom} from ${homeRoom}.`;
};

global.cancelThiefOrder = function(targetRoom) {
    if (!targetRoom) {
        return `[Thief] Invalid command. Use: cancelThiefOrder('targetRoomName')`;
    }
    if (!Memory.thiefOrders || Memory.thiefOrders.length === 0) {
        return `[Thief] No active thief orders to cancel.`;
    }

    const orderIndex = Memory.thiefOrders.findIndex(o => o.targetRoom === targetRoom);

    if (orderIndex > -1) {
        Memory.thiefOrders.splice(orderIndex, 1);
        return `[Thief] Operation against ${targetRoom} has been cancelled. Existing thieves will not be replaced.`;
    } else {
        return `[Thief] No active operation found for target room ${targetRoom}.`;
    }
};

global.orderTowerDrain = function(homeRoom, targetRoom, count) {
    if (!Game.rooms[homeRoom] || !Game.rooms[homeRoom].controller || !Game.rooms[homeRoom].controller.my) {
        return `[TowerDrain] Invalid home room: ${homeRoom}. Must be a room you own.`;
    }
    if (!targetRoom || !count || count <= 0) {
        return `[TowerDrain] Invalid order. Use: orderTowerDrain('homeRoomName', 'targetRoomName', creepCount)`;
    }
    if (!Memory.towerDrainOrders) {
        Memory.towerDrainOrders = [];
    }
    const existingOrder = Memory.towerDrainOrders.find(o => o.targetRoom === targetRoom && o.homeRoom === homeRoom);
    if (existingOrder) {
        return `[TowerDrain] An operation against ${targetRoom} from ${homeRoom} is already active.`;
    }

    Memory.towerDrainOrders.push({
        homeRoom: homeRoom,
        targetRoom: targetRoom,
        count: parseInt(count, 10)
    });
    return `[TowerDrain] Order placed for ${count} tower drain bots to drain ${targetRoom} from ${homeRoom}.`;
};

global.cancelTowerDrainOrder = function(homeRoom, targetRoom) {
    if (!homeRoom || !targetRoom) {
        return `[TowerDrain] Invalid command. Use: cancelTowerDrainOrder('homeRoomName', 'targetRoomName')`;
    }
    if (!Memory.towerDrainOrders || Memory.towerDrainOrders.length === 0) {
        return `[TowerDrain] No active tower drain orders to cancel.`;
    }

    const orderIndex = Memory.towerDrainOrders.findIndex(o => o.targetRoom === targetRoom && o.homeRoom === homeRoom);

    if (orderIndex > -1) {
        Memory.towerDrainOrders.splice(orderIndex, 1);
        return `[TowerDrain] Operation against ${targetRoom} from ${homeRoom} has been cancelled.`;
    } else {
        return `[TowerDrain] No active operation found for ${homeRoom} -> ${targetRoom}.`;
    }
};

global.orderDemolition = function(homeRoom, targetRoom, teamCount = 1) {
    if (!Game.rooms[homeRoom] || !Game.rooms[homeRoom].controller || !Game.rooms[homeRoom].controller.my) {
        return `[Demolition] Invalid home room: ${homeRoom}. Must be a room you own.`;
    }
    if (!targetRoom || teamCount <= 0) {
        return `[Demolition] Invalid order. Use: orderDemolition('homeRoomName', 'targetRoomName', teamCount)`;
    }

    // Safety check against friendly rooms
    const targetRoomObj = Game.rooms[targetRoom];
    if (targetRoomObj && targetRoomObj.controller && targetRoomObj.controller.owner) {
        if (iff.isAlly(targetRoomObj.controller.owner.username)) {
            return `[Demolition] Cannot demolish ${targetRoom} - it's owned by ally ${targetRoomObj.controller.owner.username}`;
        }
        if (targetRoomObj.controller.my) {
            return `[Demolition] Cannot demolish ${targetRoom} - it's your own room!`;
        }
    }

    if (!Memory.demolitionOrders) {
        Memory.demolitionOrders = [];
    }
    const existingOrder = Memory.demolitionOrders.find(o => o.targetRoom === targetRoom);
    if (existingOrder) {
        return `[Demolition] An operation against ${targetRoom} is already active. Cancel it first to create a new one.`;
    }

    Memory.demolitionOrders.push({
        homeRoom: homeRoom,
        targetRoom: targetRoom,
        teamCount: parseInt(teamCount, 10),
        teamsSpawned: 0
    });
    return `[Demolition] Order placed for ${teamCount} demolition team(s) to demolish ${targetRoom} from ${homeRoom}.`;
};

global.cancelDemolitionOrder = function(targetRoom) {
    if (!targetRoom) {
        return `[Demolition] Invalid command. Use: cancelDemolitionOrder('targetRoomName')`;
    }
    if (!Memory.demolitionOrders || Memory.demolitionOrders.length === 0) {
        return `[Demolition] No active demolition orders to cancel.`;
    }

    const orderIndex = Memory.demolitionOrders.findIndex(o => o.targetRoom === targetRoom);

    if (orderIndex > -1) {
        Memory.demolitionOrders.splice(orderIndex, 1);
        return `[Demolition] Operation against ${targetRoom} has been cancelled. Existing demolition teams will not be replaced.`;
    } else {
        return `[Demolition] No active operation found for target room ${targetRoom}.`;
    }
};

// --- SQUAD COMMANDS ---
global.orderSquad = function(formRoom, attackRoom, numSquads = 1) {
    if (!Game.rooms[formRoom] || !Game.rooms[formRoom].controller || !Game.rooms[formRoom].controller.my) {
        return `[Squad] Invalid form room: ${formRoom}. Must be a room you own.`;
    }
    if (!attackRoom || numSquads <= 0) {
        return `[Squad] Invalid order. Use: orderSquad('formRoomName', 'attackRoomName', numSquads)`;
    }

    // Safety check against friendly rooms
    const targetRoomObj = Game.rooms[attackRoom];
    if (targetRoomObj && targetRoomObj.controller && targetRoomObj.controller.owner) {
        if (iff.isAlly(targetRoomObj.controller.owner.username)) {
            return `[Squad] Cannot attack ${attackRoom} - it's owned by ally ${targetRoomObj.controller.owner.username}`;
        }
        if (targetRoomObj.controller.my) {
            return `[Squad] Cannot attack ${attackRoom} - it's your own room!`;
        }
    }

    squad.spawnSquads(formRoom, attackRoom, numSquads);
    return `[Squad] Order placed for ${numSquads} squad(s) to attack ${attackRoom} from ${formRoom}.`;
};

global.cancelSquadOrder = function(attackRoom) {
    if (!attackRoom) {
        return `[Squad] Invalid command. Use: cancelSquadOrder('attackRoomName')`;
    }
    if (!Memory.squadQueues || Memory.squadQueues.length === 0) {
        return `[Squad] No active squad orders to cancel.`;
    }

    const initialLength = Memory.squadQueues.length;
    Memory.squadQueues = Memory.squadQueues.filter(q => q.attackRoom !== attackRoom);

    if (Memory.squadPackingAreas) {
        for (const squadId in Memory.squadPackingAreas) {
            if (squadId.includes(attackRoom)) {
                delete Memory.squadPackingAreas[squadId];
            }
        }
    }

    const removed = initialLength - Memory.squadQueues.length;
    if (removed > 0) {
        return `[Squad] Cancelled ${removed} squad queue(s) for ${attackRoom}. Existing squad members will continue their mission.`;
    } else {
        return `[Squad] No active squad orders found for ${attackRoom}.`;
    }
};

// Add this to your main.js or wherever your global functions are defined
global.orderAttack = function(targetRoom, count, rallyRoom = null) {
  if (!targetRoom || !count || count <= 0) {
    return `[Attack] Invalid command. Use: orderAttack('targetRoom', count, 'rallyRoom')`;
  }

  // If no rally room specified, use the closest room to target
  if (!rallyRoom) {
    let minDistance = Infinity;
    for (const roomName in Game.rooms) {
      const room = Game.rooms[roomName];
      if (!room.controller || !room.controller.my) continue;
      const distance = Game.map.getRoomLinearDistance(roomName, targetRoom);
      if (distance < minDistance) {
        minDistance = distance;
        rallyRoom = roomName;
      }
    }
  }

  // Validate rally room
  if (!Game.rooms[rallyRoom] || !Game.rooms[rallyRoom].controller || !Game.rooms[rallyRoom].controller.my) {
    return `[Attack] Invalid rally room: ${rallyRoom}. Must be a room you control.`;
  }

  if (!Memory.attackOrders) Memory.attackOrders = [];

  const existingOrder = Memory.attackOrders.find(o => o.targetRoom === targetRoom);
  if (existingOrder) {
    return `[Attack] Attack order for ${targetRoom} already exists!`;
  }

  const rallyPoint = findRallyPointInRoom(Game.rooms[rallyRoom]);

  Memory.attackOrders.push({
    targetRoom: targetRoom,
    rallyRoom: rallyRoom,
    count: count,
    spawned: 0,
    startTime: Game.time,
    rallyPoint: rallyPoint,
    rallyPhase: 'spawning' // spawning -> rallying -> attacking
  });

  console.log(`[Attack] Order created: ${count} attackers to attack ${targetRoom}, rally in ${rallyRoom}`);
  return `[Attack] Order created: ${count} attackers to attack ${targetRoom}, rally in ${rallyRoom}`;
};

function findRallyPointInRoom(room) {
  const spawns = room.find(FIND_MY_SPAWNS);
  const sources = room.find(FIND_SOURCES);

  const candidatePoints = [
    {x: 15, y: 15}, {x: 35, y: 15}, {x: 15, y: 35}, {x: 35, y: 35},
    {x: 10, y: 25}, {x: 40, y: 25}, {x: 25, y: 10}, {x: 25, y: 40}
  ];

  let bestPoint = candidatePoints[0];
  let bestMinDistance = 0;

  for (const point of candidatePoints) {
    let minDistance = 50;

    spawns.forEach(spawn => {
      const distance = Math.max(Math.abs(point.x - spawn.pos.x), Math.abs(point.y - spawn.pos.y));
      minDistance = Math.min(minDistance, distance);
    });

    sources.forEach(source => {
      const distance = Math.max(Math.abs(point.x - source.pos.x), Math.abs(point.y - source.pos.y));
      minDistance = Math.min(minDistance, distance);
    });

    const terrain = room.getTerrain();
    if (terrain.get(point.x, point.y) !== TERRAIN_MASK_WALL && minDistance > bestMinDistance) {
      bestMinDistance = minDistance;
      bestPoint = point;
    }
  }

  return bestPoint;
}

function spawnScavengers() {
  if (!Game.events) return;
  for (const event of Game.events) {
    if (event.event === EVENT_OBJECT_DESTROYED && event.data.type === 'creep') {
      const destroyer = Game.getObjectById(event.data.destroyerId);
      if (destroyer &&
          destroyer.structureType === STRUCTURE_TOWER &&
          destroyer.my) {
        const room = destroyer.room;
        const spawn = room.find(FIND_MY_SPAWNS, { filter: s => !s.spawning })[0];
        if (spawn) {
          const name = `Scavenger_${room.name}_${Game.time}`;
          const memory = { role: 'scavenger', homeRoom: room.name };
          spawn.spawnCreep(SCAVENGER_BODY, name, { memory });
        }
      }
    }
  }
}

function processSquadSpawnQueues() {
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;

    const spawns = room.find(FIND_MY_SPAWNS);
    if (spawns.length === 0) continue;

    squad.processSpawnQueue(roomName);
  }
}

global.assignAttackTarget = function(roomName, targetId) {
  if (!roomName || !targetId) {
    return `[Attack] Invalid command. Use global.assignAttackTarget('roomName', 'targetId').`;
  }
  const attackersInRoom = _.filter(Game.creeps, c => c.memory.role === 'attacker' && c.memory.targetRoom === roomName);
  if (attackersInRoom.length === 0) {
    return `[Attack] No attackers found for room ${roomName}.`;
  }
  let assignedCount = 0;
  for (const creep of attackersInRoom) {
    creep.memory.assignedTargetId = targetId;
    assignedCount++;
  }
  return `[Attack] Assigned target ${targetId} to ${assignedCount} attackers in room ${roomName}.`;
};

global.cancelAttackOrder = function (targetRoom) {
  if (!Memory.attackOrders || Memory.attackOrders.length === 0)
    return '[Attack] No active attack orders.';

  const i = Memory.attackOrders.findIndex(o => o.targetRoom === targetRoom);
  if (i === -1)
    return `[Attack] No attack order found for ${targetRoom}.`;

  Memory.attackOrders.splice(i, 1);
  return `[Attack] Attack on ${targetRoom} has been cancelled.`;
};

// --- CPU PROFILING ---
if (ENABLE_CPU_LOGGING && !Memory.cpuProfile) Memory.cpuProfile = {};
function profileSection(name, fn) {
  if (!ENABLE_CPU_LOGGING) {
    fn();
    return;
  }
  const start = Game.cpu.getUsed();
  fn();
  const used = Game.cpu.getUsed() - start;
  if (!Memory.cpuProfile[name]) Memory.cpuProfile[name] = [];
  Memory.cpuProfile[name].push(used);
  if (Memory.cpuProfile[name].length > 50) Memory.cpuProfile[name].shift();
  if (!Memory.cpuProfileLastUsed) Memory.cpuProfileLastUsed = {};
  Memory.cpuProfileLastUsed[name] = Game.time;
}

function cleanCpuProfileMemory(maxAge = 5000) {
  if (!Memory.cpuProfileLastUsed) return;
  const now = Game.time;
  for (const key in Memory.cpuProfileLastUsed) {
    if (now - Memory.cpuProfileLastUsed[key] > maxAge) {
      delete Memory.cpuProfile[key];
      delete Memory.cpuProfileLastUsed[key];
    }
  }
}

// --- STRUCTURE LOGIC ---
function runLinks() {
  for(const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if(!room.controller || !room.controller.my) continue;
    const allLinks = room.find(FIND_MY_STRUCTURES, {
      filter: { structureType: STRUCTURE_LINK }
    });
    if(allLinks.length < 2) continue;

    const sources       = room.find(FIND_SOURCES);
    const storage       = room.storage;
    const controller    = room.controller;
    const recipientLinks= [];
    const sendingLinks  = [];

    for (const link of allLinks) {
      if (controller && link.pos.inRangeTo(controller, 5)) {
        recipientLinks.push(link);
      } else {
        sendingLinks.push(link);
      }
    }

    const storageLinks = sendingLinks.filter(l => storage && l.pos.inRangeTo(storage, 3));
    const donorLinks   = sendingLinks.filter(l => sources.some(s => l.pos.inRangeTo(s, 3)));

    for (const storageLink of storageLinks) {
      if (storageLink.cooldown > 0 || storageLink.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
        continue;
      }
      const targetRecipient = recipientLinks.find(r => r.store.getUsedCapacity(RESOURCE_ENERGY) < 400);
      if (targetRecipient) {
        const result = storageLink.transferEnergy(targetRecipient);
        if (result === OK) {
          continue;
        }
      }
    }

    for (const donorLink of donorLinks) {
      if (donorLink.cooldown > 0 || donorLink.store[RESOURCE_ENERGY] <= 400) {
        continue;
      }
      let potentialTargets = [...storageLinks, ...recipientLinks];
      potentialTargets = potentialTargets.filter(l => l.id !== donorLink.id);
      if (potentialTargets.length > 0) {
        const target = _.min(potentialTargets, l => l.store[RESOURCE_ENERGY]);
        if (target && target.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
          donorLink.transferEnergy(target);
        }
      }
    }
  }
}

function runTowers () {
  if (Memory.towerTargets === undefined) Memory.towerTargets = {};

  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;

    const towers   = room.find(FIND_MY_STRUCTURES,
                               { filter: { structureType: STRUCTURE_TOWER } });
    if (!towers.length) continue;

    const hostiles = room.find(FIND_HOSTILE_CREEPS,
                               { filter: creep => iff.isHostileCreep(creep) });
    const healers  = hostiles.filter(c => c.getActiveBodyparts(HEAL) > 0);

    let injuredCreeps   = null;
    let damagedNonWall  = null;
    let weakestWall     = null;

    const tickMod5 = (Game.time % 2) === 0;

    // Special case: 2 enemies with specific composition
    let specialTargeting = false;
    let healerOnly = null;
    let workerAttacker = null;

    if (hostiles.length === 2 && towers.length > 1) {
      const enemy1 = hostiles[0];
      const enemy2 = hostiles[1];

      // Check if one is healer-only and other is worker/attacker
      if (enemy1.getActiveBodyparts(HEAL) > 0 && enemy1.getActiveBodyparts(ATTACK) === 0 &&
          enemy2.getActiveBodyparts(HEAL) === 0 && 
          (enemy2.getActiveBodyparts(WORK) > 0 || enemy2.getActiveBodyparts(ATTACK) > 0)) {
        specialTargeting = true;
        healerOnly = enemy1;
        workerAttacker = enemy2;
      } else if (enemy2.getActiveBodyparts(HEAL) > 0 && enemy2.getActiveBodyparts(ATTACK) === 0 &&
                 enemy1.getActiveBodyparts(HEAL) === 0 && 
                 (enemy1.getActiveBodyparts(WORK) > 0 || enemy1.getActiveBodyparts(ATTACK) > 0)) {
        specialTargeting = true;
        healerOnly = enemy2;
        workerAttacker = enemy1;
      }
    }

    for (let i = 0; i < towers.length; i++) {
      const tower = towers[i];
      const mem = Memory.towerTargets[tower.id] ||
                 (Memory.towerTargets[tower.id] = { targetId: null, lastHp: 0, sameHp: 0 });

      let target = null;

      // Special targeting logic for 2-enemy scenario
      if (specialTargeting) {
        // Distribute towers: at least one on each target
        // First tower (and odd-indexed towers) target healer-only
        // Second tower (and even-indexed towers) target worker/attacker
        if (i % 2 === 0) {
          target = healerOnly;
        } else {
          target = workerAttacker;
        }
      } else {
        // Original targeting logic
        if (healers.length)          target = tower.pos.findClosestByRange(healers);
        else if (hostiles.length)    target = tower.pos.findClosestByRange(hostiles);
      }

      if (target) {
        if (mem.targetId === target.id) {
          mem.sameHp = (mem.lastHp === target.hits) ? mem.sameHp + 1 : 0;
        } else {
          mem.targetId = target.id;
          mem.sameHp   = 0;
        }
        mem.lastHp = target.hits;

        // Only switch targets if not in special targeting mode and hitting same HP for 5+ ticks
        if (!specialTargeting && mem.sameHp >= 5) {
          const others = hostiles.filter(h => h.id !== target.id);
          if (others.length) {
            target       = tower.pos.findClosestByRange(others);
            mem.targetId = target.id;
            mem.lastHp   = target.hits;
            mem.sameHp   = 0;
          }
        }

        tower.attack(target);
        continue;
      }

      mem.targetId = null; mem.lastHp = 0; mem.sameHp = 0;

      if (injuredCreeps === null) {
        injuredCreeps = room.find(FIND_MY_CREEPS,
                                  { filter: c => c.hits < c.hitsMax });
      }
      if (injuredCreeps.length) {
        const healTarget = tower.pos.findClosestByRange(injuredCreeps);
        if (healTarget) { tower.heal(healTarget); continue; }
      }

      if (damagedNonWall === null) {
        damagedNonWall = room.find(FIND_STRUCTURES, {
          filter: s => s.hits < s.hitsMax &&
                       s.structureType !== STRUCTURE_WALL &&
                       s.structureType !== STRUCTURE_RAMPART
        });
      }
      if (damagedNonWall.length) {
        let weakest = damagedNonWall[0];
        for (let i = 1; i < damagedNonWall.length; i++) {
          if (damagedNonWall[i].hits < weakest.hits) weakest = damagedNonWall[i];
        }
        tower.repair(weakest);
        continue;
      }

      if (tickMod5 && tower.store[RESOURCE_ENERGY] > tower.store.getCapacity(RESOURCE_ENERGY) * 0.77) {
        if (weakestWall === null) {
          const walls = room.find(FIND_STRUCTURES, {
            filter: s => (s.structureType === STRUCTURE_WALL ||
                          s.structureType === STRUCTURE_RAMPART) &&
                         s.hits < 1000000
          });
          if (walls.length) {
            weakestWall = walls[0];
            for (let i = 1; i < walls.length; i++) {
              if (walls[i].hits < weakestWall.hits) weakestWall = walls[i];
            }
          }
        }
        if (weakestWall) tower.repair(weakestWall);
      }
    }
  }
}

// =================================================================
// === SPAWN MANAGEMENT ============================================
// =================================================================

function manageTowerDrainSpawns() {
    if (!Memory.towerDrainOrders || Memory.towerDrainOrders.length === 0) return;

    for (const order of Memory.towerDrainOrders) {
        const { homeRoom, targetRoom, count } = order;

        const existingDrainers = _.filter(Game.creeps, c =>
            c.memory.role === 'towerDrain' &&
            c.memory.targetRoom === targetRoom &&
            c.memory.homeRoom === homeRoom
        );

        if (existingDrainers.length >= count) {
            continue; // Order is fulfilled
        }

        const home = Game.rooms[homeRoom];
        if (!home || !home.controller || !home.controller.my) {
            console.log(`[TowerDrain] Home room ${homeRoom} is no longer valid. Skipping spawn.`);
            continue;
        }

        const spawn = home.find(FIND_MY_SPAWNS, { filter: s => !s.spawning })[0];
        if (!spawn) {
            continue; // No available spawn
        }

        const cost = bodyCost(TOWER_DRAIN_BODY);

        if (cost > spawn.room.energyAvailable) {
            if (Game.time % 10 === 0) {
                console.log(`[TowerDrain] Not enough energy in ${homeRoom}. Have: ${spawn.room.energyAvailable}, Need: ${cost}`);
            }
            continue;
        }

        const newName = `TowerDrain_${targetRoom}_${Game.time % 1000}`;
        const memory = {
            role: 'towerDrain',
            homeRoom: homeRoom,
            targetRoom: targetRoom
        };

        const result = spawn.spawnCreep(TOWER_DRAIN_BODY, newName, { memory: memory });
        if (result === OK) {
            console.log(`[TowerDrain] Spawning '${newName}' from ${homeRoom} to drain towers in ${targetRoom}.`);
        } else if (result !== ERR_BUSY && result !== ERR_NOT_ENOUGH_ENERGY) {
            console.log(`[TowerDrain] Error spawning tower drain bot in ${homeRoom}: ${result}`);
        }
    }
}

function manageDemolitionSpawns() {
    if (!Memory.demolitionOrders || Memory.demolitionOrders.length === 0) return;

    // Initialize collector queue if it doesn't exist
    if (!Memory.demolitionCollectorQueue) Memory.demolitionCollectorQueue = [];

    // Process collector queue first (for previously spawned demolishers)
    for (let i = Memory.demolitionCollectorQueue.length - 1; i >= 0; i--) {
        const queueItem = Memory.demolitionCollectorQueue[i];
        const home = Game.rooms[queueItem.homeRoom];
        if (!home) {
            Memory.demolitionCollectorQueue.splice(i, 1);
            continue;
        }

        const spawn = home.find(FIND_MY_SPAWNS, { filter: s => !s.spawning })[0];
        if (!spawn) continue;

        const cost = bodyCost(queueItem.collectorBody);
        if (cost > spawn.room.energyAvailable) {
            if (Game.time % 20 === 0) {
                console.log(`[Demolition] Not enough energy in ${queueItem.homeRoom} for collector. Have: ${spawn.room.energyAvailable}, Need: ${cost}`);
            }
            continue;
        }

        const collectorMemory = {
            role: 'demolition',
            demolitionRole: 'collector',
            homeRoom: queueItem.homeRoom,
            targetRoom: queueItem.targetRoom,
            partnerName: queueItem.demolisherName,
            teamId: queueItem.teamId
        };

        const result = spawn.spawnCreep(queueItem.collectorBody, queueItem.collectorName, { memory: collectorMemory });
        if (result === OK) {
            console.log(`[Demolition] Spawning collector '${queueItem.collectorName}' from ${queueItem.homeRoom} for ${queueItem.targetRoom}.`);
            Memory.demolitionCollectorQueue.splice(i, 1);
        } else if (result !== ERR_BUSY) {
            console.log(`[Demolition] Failed to spawn collector '${queueItem.collectorName}': ${result}`);
        }
    }

    // Now handle demolition orders
    for (const order of Memory.demolitionOrders) {
        const { homeRoom, targetRoom, teamCount } = order;

        const home = Game.rooms[homeRoom];
        if (!home || !home.controller || !home.controller.my) {
            console.log(`[Demolition] Home room ${homeRoom} is no longer valid. Skipping spawn.`);
            continue;
        }

        const spawns = home.find(FIND_MY_SPAWNS, { filter: s => !s.spawning });
        if (spawns.length === 0) continue;

        // Check existing demolition creeps for this order
        const existingCreeps = _.filter(Game.creeps, c => 
            c.memory.role === 'demolition' && 
            c.memory.targetRoom === targetRoom && 
            c.memory.homeRoom === homeRoom
        );

        const existingDemolishers = existingCreeps.filter(c => c.memory.demolitionRole === 'demolisher');
        const existingCollectors = existingCreeps.filter(c => c.memory.demolitionRole === 'collector');

        // Group creeps by teamId to find complete pairs
        const teamIds = new Set();
        const completePairs = new Set();

        // Collect all team IDs
        existingCreeps.forEach(creep => {
            if (creep.memory.teamId) {
                teamIds.add(creep.memory.teamId);
            }
        });

        // Check which teams have both demolisher and collector
        teamIds.forEach(teamId => {
            const teamDemolisher = existingDemolishers.find(c => c.memory.teamId === teamId);
            const teamCollector = existingCollectors.find(c => c.memory.teamId === teamId);

            if (teamDemolisher && teamCollector) {
                completePairs.add(teamId);
            }
        });

        const activeTeams = completePairs.size;
        const teamsNeeded = teamCount - activeTeams;

        if (Game.time % 20 === 0 && teamsNeeded > 0) {
            console.log(`[Demolition] Order ${homeRoom}->${targetRoom}: Need ${teamsNeeded} teams, have ${activeTeams} complete pairs`);
        }

        // Spawn new teams if needed
        for (let i = 0; i < teamsNeeded; i++) {
            const spawn = spawns[0];
            if (!spawn) break;

            // Define bodies
            const demolisherBody = [
                WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, // 10 WORK parts
                CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, // 10 CARRY parts (500 capacity)
                MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE // 10 MOVE parts
            ];

            const collectorBody = getCreepBody('supplier', spawn.room.energyAvailable);

            const demolisherCost = bodyCost(demolisherBody);

            // Check if we can afford the demolisher
            if (demolisherCost > spawn.room.energyAvailable) {
                if (Game.time % 20 === 0) {
                    console.log(`[Demolition] Not enough energy in ${homeRoom} for demolisher. Have: ${spawn.room.energyAvailable}, Need: ${demolisherCost}`);
                }
                break;
            }

            // Generate unique names
            const teamId = `${targetRoom}_${Game.time}_${Math.floor(Math.random() * 1000)}`;
            const demolisherName = `Demolisher_${teamId}`;
            const collectorName = `Collector_${teamId}`;

            // Spawn demolisher
            const demolisherMemory = {
                role: 'demolition',
                demolitionRole: 'demolisher',
                homeRoom: homeRoom,
                targetRoom: targetRoom,
                partnerName: collectorName,
                teamId: teamId
            };

            const demolisherResult = spawn.spawnCreep(demolisherBody, demolisherName, { memory: demolisherMemory });
            if (demolisherResult === OK) {
                console.log(`[Demolition] Spawning replacement demolisher '${demolisherName}' from ${homeRoom} for ${targetRoom}.`);

                // Queue collector spawn for next available spawn
                Memory.demolitionCollectorQueue.push({
                    homeRoom: homeRoom,
                    collectorName: collectorName,
                    demolisherName: demolisherName,
                    targetRoom: targetRoom,
                    teamId: teamId,
                    collectorBody: collectorBody
                });

                break; // Only spawn one team per tick
            } else if (demolisherResult !== ERR_BUSY) {
                console.log(`[Demolition] Failed to spawn replacement demolisher '${demolisherName}': ${demolisherResult}`);
                break;
            }
        }
    }
}

function manageThiefSpawns() {
    if (!Memory.thiefOrders || Memory.thiefOrders.length === 0) return;

    // --- Filter out orders that should be cancelled ---
    const activeOrders = Memory.thiefOrders.filter(order => {
        const targetRoomObject = Game.rooms[order.targetRoom];
        // If we don't have vision of the target room, we can't check it, so keep the order active.
        if (!targetRoomObject) {
            return true;
        }

        // We have vision, so check for any resources in target structures.
        const structuresWithResources = targetRoomObject.find(FIND_STRUCTURES, {
            filter: s => (s.structureType === STRUCTURE_EXTENSION ||
                          s.structureType === STRUCTURE_SPAWN ||
                          s.structureType === STRUCTURE_TOWER ||
                          s.structureType === STRUCTURE_STORAGE ||
                          s.structureType === STRUCTURE_CONTAINER ||
                          s.structureType === STRUCTURE_LAB ||
                          s.structureType === STRUCTURE_TERMINAL) &&
                         _.sum(s.store) > 0
        });

        // If no structures with resources are found, the room is empty. Cancel the order.
        if (structuresWithResources.length === 0) {
            console.log(`[Thief] Target room ${order.targetRoom} appears to be empty. Cancelling operation.`);
            return false; // This will remove the order from the active list.
        }

        return true; // Keep the order active.
    });

    // Update memory with only the orders that are still active.
    Memory.thiefOrders = activeOrders;

    // --- Process the remaining active orders ---
    for (const order of Memory.thiefOrders) {
        const { homeRoom, targetRoom, count } = order;

        const existingThieves = _.filter(Game.creeps, c =>
            c.memory.role === 'thief' &&
            c.memory.targetRoom === targetRoom &&
            c.memory.homeRoom === homeRoom
        );

        if (existingThieves.length >= count) {
            continue; // Order is fulfilled for now
        }

        const home = Game.rooms[homeRoom];
        if (!home || !home.controller || !home.controller.my) {
            console.log(`[Thief] Home room ${homeRoom} for raid on ${targetRoom} is no longer valid. Skipping spawn.`);
            continue;
        }

        const spawn = home.find(FIND_MY_SPAWNS, { filter: s => !s.spawning })[0];
        if (!spawn) {
            continue; // No available spawn in the designated home room
        }

        const body = getCreepBody('supplier', spawn.room.energyAvailable);
        const cost = bodyCost(body);

        if (!body || cost > spawn.room.energyAvailable) {
            if (Game.time % 10 === 0) { // Log only periodically to prevent spam
                 console.log(`[Thief] Not enough energy in ${homeRoom} to spawn a thief. Have: ${spawn.room.energyAvailable}, Need: ${cost}`);
            }
            continue;
        }

        const newName = `Thief_${targetRoom}_${Game.time % 1000}`;
        const memory = {
            role: 'thief',
            homeRoom: homeRoom,
            targetRoom: targetRoom,
            stealing: true
        };

        const result = spawn.spawnCreep(body, newName, { memory: memory });
        if (result === OK) {
            console.log(`[Thief] Spawning '${newName}' from ${homeRoom} for raid on ${targetRoom}.`);
        } else if (result !== ERR_BUSY && result !== ERR_NOT_ENOUGH_ENERGY) {
            console.log(`[Thief] Error spawning thief in ${homeRoom}: ${result}`);
        }
    }
}

function manageAttackerSpawns() {
  if (!Memory.attackOrders || Memory.attackOrders.length === 0) return;

  for (let i = Memory.attackOrders.length - 1; i >= 0; i--) {
    const order = Memory.attackOrders[i];
    const { targetRoom, rallyRoom, count, spawned, startTime, rallyPhase } = order;

    // Handle different phases
    if (rallyPhase === 'spawning') {
      // Continue spawning until we have enough or timeout
      if (spawned < count) {
        const spawnResults = trySpawnAttackersFromAllRooms(order, i);
        if (spawnResults > 0) {
          order.spawned += spawnResults;
          console.log(`[Attack] Spawned ${spawnResults} attackers (${order.spawned}/${count} total) for ${targetRoom}`);
        }
      }

      // Check if we should move to rally phase
      const timeElapsed = Game.time - startTime;
      if (spawned >= count || timeElapsed >= 50) {
        order.rallyPhase = 'rallying';
        order.rallyStartTime = Game.time;
        console.log(`[Attack] Moving to rally phase for ${targetRoom} (${spawned}/${count} spawned)`);
      }
    }

    else if (rallyPhase === 'rallying') {
      // Count attackers at rally point
      const attackersAtRally = _.filter(Game.creeps, c => 
        c.memory.role === 'attacker' && 
        c.memory.targetRoom === targetRoom &&
        c.room.name === rallyRoom &&
        c.pos.getRangeTo(order.rallyPoint.x, order.rallyPoint.y) <= 3
      );

      const rallyTimeElapsed = Game.time - order.rallyStartTime;
      const shouldProceed = rallyTimeElapsed >= 50 || attackersAtRally.length >= spawned;

      if (shouldProceed) {
        // Mark all attackers of this order to proceed
        const allAttackers = _.filter(Game.creeps, c => 
          c.memory.role === 'attacker' && c.memory.targetRoom === targetRoom
        );

        allAttackers.forEach(creep => {
          creep.memory.rallyComplete = true;
        });

        order.rallyPhase = 'attacking';
        console.log(`[Attack] Rally complete for ${targetRoom}. ${allAttackers.length} attackers proceeding to attack.`);
      }
    }

    else if (rallyPhase === 'attacking') {
      // Check if any attackers are still alive
      const remainingAttackers = _.filter(Game.creeps, c => 
        c.memory.role === 'attacker' && c.memory.targetRoom === targetRoom
      );

      if (remainingAttackers.length === 0) {
        console.log(`[Attack] All attackers for ${targetRoom} have been eliminated. Order complete.`);
        Memory.attackOrders.splice(i, 1);
      }
    }
  }
}

function trySpawnAttackersFromAllRooms(order, orderIndex) {
  let totalSpawned = 0;
  const remainingToSpawn = order.count - order.spawned;

  if (remainingToSpawn <= 0) return 0;

  // Get all rooms with available spawns
  const roomsWithSpawns = [];

  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;

    const spawns = room.find(FIND_MY_SPAWNS, { filter: s => !s.spawning });
    const availableSpawns = spawns.filter(spawn => {
      const body = getCreepBody('attacker', spawn.room.energyAvailable);
      const cost = bodyCost(body);
      return body && cost <= spawn.room.energyAvailable;
    });

    if (availableSpawns.length > 0) {
      roomsWithSpawns.push({
        roomName: roomName,
        room: room,
        spawns: availableSpawns,
        distance: Game.map.getRoomLinearDistance(roomName, order.targetRoom)
      });
    }
  }

  if (roomsWithSpawns.length === 0) return 0;

  // Initialize spawn tracking for this order if it doesn't exist
  if (!order.roomSpawnCount) {
    order.roomSpawnCount = {};
  }

  // Calculate how many each room should spawn (even distribution)
  const basePerRoom = Math.floor(remainingToSpawn / roomsWithSpawns.length);
  const extraSpawns = remainingToSpawn % roomsWithSpawns.length;

  // Distribute spawning evenly
  for (let i = 0; i < roomsWithSpawns.length && totalSpawned < remainingToSpawn; i++) {
    const roomInfo = roomsWithSpawns[i];
    const shouldSpawnFromRoom = basePerRoom + (i < extraSpawns ? 1 : 0);
    const alreadySpawnedFromRoom = order.roomSpawnCount[roomInfo.roomName] || 0;
    const needToSpawnFromRoom = Math.max(0, shouldSpawnFromRoom - alreadySpawnedFromRoom);

    if (needToSpawnFromRoom > 0 && roomInfo.spawns.length > 0) {
      const spawn = roomInfo.spawns[0]; // Use first available spawn
      const body = getCreepBody('attacker', spawn.room.energyAvailable);

      const attackerName = `Attacker_${order.targetRoom}_${Game.time}_${order.spawned + totalSpawned}`;
      const result = spawn.spawnCreep(body, attackerName, {
        memory: {
          role: 'attacker',
          targetRoom: order.targetRoom,
          rallyRoom: order.rallyRoom,
          spawnRoom: roomInfo.roomName,
          orderIndex: orderIndex,
          rallyComplete: false
        }
      });

      if (result === OK) {
        totalSpawned++;
        order.roomSpawnCount[roomInfo.roomName] = alreadySpawnedFromRoom + 1;
        console.log(`[Attack] Spawning attacker from ${roomInfo.roomName} (${order.roomSpawnCount[roomInfo.roomName]} from this room) for ${order.targetRoom}`);
      }
    }
  }

  return totalSpawned;
}

function trySpawnAttacker(order, orderIndex) {
  // Find best available spawn across all rooms
  let bestSpawn = null;
  let minDistance = Infinity;

  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;

    const spawns = room.find(FIND_MY_SPAWNS, { filter: s => !s.spawning });
    if (spawns.length === 0) continue;

    const distance = Game.map.getRoomLinearDistance(roomName, order.targetRoom);
    if (distance < minDistance) {
      minDistance = distance;
      bestSpawn = spawns[0];
    }
  }

  if (!bestSpawn) return false;

  const body = getCreepBody('attacker', bestSpawn.room.energyAvailable);
  const cost = bodyCost(body);

  if (!body || cost > bestSpawn.room.energyAvailable) return false;

  const attackerName = `Attacker_${order.targetRoom}_${Game.time}_${order.spawned}`;
  const result = bestSpawn.spawnCreep(body, attackerName, {
    memory: {
      role: 'attacker',
      targetRoom: order.targetRoom,
      rallyRoom: order.rallyRoom,
      spawnRoom: bestSpawn.room.name,
      orderIndex: orderIndex,
      rallyComplete: false
    }
  });

  return result === OK;
}

function manageExtractorSpawns() {
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;

    const extractor = room.find(FIND_MY_STRUCTURES, {
      filter: s => s.structureType === STRUCTURE_EXTRACTOR
    })[0];
    if (!extractor) continue;

    const mineral = room.find(FIND_MINERALS)[0];
    if (!mineral || mineral.mineralAmount === 0) continue;

    const container = extractor.pos.findInRange(FIND_STRUCTURES, 1, {
      filter: s => s.structureType === STRUCTURE_CONTAINER
    })[0];
    if (!container) continue;

    const existing = _.filter(Game.creeps, c =>
      c.memory.role === 'extractor' && c.memory.roomName === roomName
    );
    if (existing.length > 0) continue;

    const spawn = room.find(FIND_MY_STRUCTURES, {
      filter: s => s.structureType === STRUCTURE_SPAWN && !s.spawning
    })[0];
    if (!spawn) continue;

    const body   = [WORK, WORK, WORK, WORK, MOVE];
    const name   = `extractor_${roomName}_${Game.time % 1000}`;
    const memory = { role: 'extractor', roomName, extractorId: extractor.id };
    const result = spawn.spawnCreep(body, name, { memory });
    if (result === OK) {
      console.log(`[Spawn] extractor for ${roomName}`);
    }
  }
}

function manageClaimbotSpawns() {
  if (!Memory.claimOrders) Memory.claimOrders = [];
  if (Memory.claimOrders.length === 0) return;

  const claimOrder = Memory.claimOrders[0];
  const existing   = _.find(
    Game.creeps,
    c => c.memory.role === 'claimbot' && c.memory.targetRoom === claimOrder.room
  );
  if (existing) return;

  let closestSpawn   = null;
  let closestDistance= Infinity;
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;
    const spawn = room.find(FIND_MY_STRUCTURES, {
      filter: { structureType: STRUCTURE_SPAWN }
    })[0];
    if (!spawn || spawn.spawning) continue;
    const distance = Game.map.getRoomLinearDistance(roomName, claimOrder.room);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestSpawn    = spawn;
    }
  }
  if (!closestSpawn) return;

  const claimBody      = [MOVE, MOVE, ATTACK, CLAIM, MOVE];
  const cost           = bodyCost(claimBody);
  const availableEnergy= closestSpawn.room.energyAvailable;
  const result         = closestSpawn.spawnCreep(
    claimBody,
    'claimbot' + Game.time,
    { memory: { role: 'claimbot', targetRoom: claimOrder.room } }
  );
  if (result === OK) {
    console.log(`Spawning claimbot for ${claimOrder.room} | Cost: ${cost} | Energy before: ${availableEnergy}`);
    Memory.claimOrders.shift();
  } else {
    console.log(`Failed to spawn claimbot: ${result}`);
  }
}

function manageSpawnsPerRoom(perRoomRoleCounts, roomDataCache) {
  if (Memory.claimOrders && Memory.claimOrders.length > 0) return;
  if(!Memory.harvesterSpawnDelay) Memory.harvesterSpawnDelay = {};

  for(const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if(!room.controller || !room.controller.my) continue;

    const spawn = room.find(FIND_MY_STRUCTURES, {
      filter: { structureType: STRUCTURE_SPAWN }
    })[0];
    if(!spawn || spawn.spawning) continue;

    const roomData    = roomDataCache[roomName] || {};
    const roleCounts  = perRoomRoleCounts[roomName] || {};
    const roomTargets = getRoomTargets(roomName, roomData, room);

    if(roleCounts.harvester === 0) {
      console.log(`EMERGENCY MODE in ${roomName}!!!`);
      const body = getCreepBody('harvester', room.energyAvailable);
      if (body && bodyCost(body) <= room.energyAvailable) {
        spawnCreepInRoom('harvester', body, spawn, roomName);
      } else {
        console.log(`Not enough energy in ${roomName} to spawn a harvester!`);
      }
      continue;
    }

    let roleToSpawn = null;
    if (roleCounts.defender  < roomTargets.defender)  roleToSpawn = 'defender';
    else if (roleCounts.harvester < roomTargets.harvester) roleToSpawn = 'harvester';
    else if (roleCounts.supplier  < roomTargets.supplier)  roleToSpawn = 'supplier';
    else if (roleCounts.upgrader  < roomTargets.upgrader)  roleToSpawn = 'upgrader';
    else if (roleCounts.builder   < roomTargets.builder)   roleToSpawn = 'builder';
    else if (roleCounts.scout     < roomTargets.scout)     roleToSpawn = 'scout';

    if(roleToSpawn) {
      if(roleToSpawn === 'harvester') {
        const totalEnergy = calculateTotalEnergy();
        if(totalEnergy < 800) {
          if(!Memory.harvesterSpawnDelay[roomName]) {
            Memory.harvesterSpawnDelay[roomName] = { nextSpawnTime: Game.time + 60 };
            console.log(`Low energy (${totalEnergy} < 800) - delaying harvester spawn in ${roomName} by 60 ticks`);
            continue;
          }
          if(Game.time < Memory.harvesterSpawnDelay[roomName].nextSpawnTime) {
            continue;
          }
          delete Memory.harvesterSpawnDelay[roomName];
        }
      }

      let energyForSpawn = room.energyAvailable;
      if (roleToSpawn === 'upgrader') {
        const sourcesCount = roomData.sources ? roomData.sources.length : 0;
        if (sourcesCount === 1) {
          energyForSpawn = Math.min(energyForSpawn, 300);
        }
      }

      const body = getCreepBody(roleToSpawn, energyForSpawn);
      spawnCreepInRoom(roleToSpawn, body, spawn, roomName);
    }
  }
}

// =================================================================
// === CREEP MANAGEMENT ============================================
// =================================================================

function runCreeps() {
  // Clean up memory first
  for (const name in Memory.creeps) {
    if (!Game.creeps[name]) {
      delete Memory.creeps[name];
    }
  }

  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    if (creep.spawning) continue;

    const role = creep.memory.role;
    let cpuBefore, cpuAfter;
    if (ENABLE_CPU_LOGGING) cpuBefore = Game.cpu.getUsed();

    switch (role) {
      case 'harvester':      roleHarvester.run(creep);       break;
      case 'upgrader':       roleUpgrader.run(creep);        break;
      case 'builder':        roleBuilder.run(creep);         break;
      case 'scout':          roleScout.run(creep);           break;
      case 'defender':       roleDefender.run(creep);        break;
      case 'supplier':       roleSupplier.run(creep);        break;
      case 'claimbot':       roleClaimbot.run(creep);        break;
      // case 'remoteHarvester':roleRemoteHarvester.run(creep); break; // disabled
      case 'attacker':       roleAttacker.run(creep);        break;
      case 'extractor':      roleExtractor.run(creep);       break;
      case 'scavenger':      roleScavenger.run(creep);       break;
      case 'thief':          roleThief.run(creep);           break;
      case 'towerDrain':     roleTowerDrain.run(creep);      break;
      case 'demolition':     roleDemolition.run(creep);      break;
      case 'squadMember':    squad.run(creep);               break;
      default:
        creep.memory.role = 'harvester';
        roleHarvester.run(creep);
        break;
    }

    if (ENABLE_CPU_LOGGING) {
      cpuAfter = Game.cpu.getUsed();
      if (!Memory.cpuProfileCreeps) Memory.cpuProfileCreeps = {};
      if (!Memory.cpuProfileCreeps[role]) Memory.cpuProfileCreeps[role] = [];
      Memory.cpuProfileCreeps[role].push(cpuAfter - cpuBefore);
      if (Memory.cpuProfileCreeps[role].length > 50) {
        Memory.cpuProfileCreeps[role].shift();
      }
    }
  }

  if (Game.time % 50 === 0 && ENABLE_CPU_LOGGING && !DISABLE_CPU_CONSOLE) {
    for (const role in Memory.cpuProfileCreeps) {
      const arr = Memory.cpuProfileCreeps[role];
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      console.log(`Creep Role CPU: ${role} avg: ${Math.round(avg)}`);
    }
  }
}

// =================================================================
// === HELPER & UTILITY FUNCTIONS ==================================
// =================================================================

function bodyCost(body) {
  const BODYPART_COST = {
    move: 50, work: 100, attack: 80, carry: 50, heal: 250,
    ranged_attack: 150, tough: 10, claim: 600
  };
  return body.reduce((cost, part) => cost + BODYPART_COST[part], 0);
}

function getCreepBody(role, energy) {
  // Special case for attacker role - use dynamic scaling logic
  if (role === 'attacker') {
    const numSets = Math.min(16, Math.floor(energy / 390));
    const body = [];
    for (let i = 0; i < numSets; i++) {
      body.push(TOUGH, MOVE, ATTACK, HEAL);
    }
    return body.length > 0 ? body : BASIC_HARVESTER; // Fallback if no sets possible
  }

  const bodyConfigs = {
    harvester: {
      300: BASIC_HARVESTER,
      400: [WORK, WORK, WORK, CARRY, MOVE],
      550: [WORK, WORK, WORK, CARRY, WORK, MOVE, MOVE],
      800: [WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE],
      950: [WORK, WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE]
    },
    upgrader: {
      200: [WORK, CARRY, MOVE],
      300: [WORK, WORK, CARRY, CARRY, MOVE],
      500: [WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE],
      600: [WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE],
      800: [WORK, WORK, WORK, WORK, WORK, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE],
      1100:[WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE]
    },
    builder: {
      300: [WORK, WORK, CARRY, MOVE],
      400: [WORK, WORK, WORK, CARRY, MOVE],
      550: [WORK, WORK, WORK, CARRY, MOVE, MOVE],
      800: [WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE],
      1200:[WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE]
    },
    defender: {
      300: BASIC_DEFENDER,
      550: [TOUGH, RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE, MOVE],
      800: [TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE, MOVE, MOVE],
      1200:[TOUGH, TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE]
    },
    supplier: {
      200:  [CARRY, CARRY, MOVE, MOVE],
      300:  [CARRY, CARRY, CARRY, MOVE, MOVE, MOVE],
      400:  [CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE],
      600:  [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      900:  [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      1000: [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      1200: [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      1400: [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      1600: [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      1800: [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      2000: [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE]
    },
    scout: { 300: SCOUT_BODY }
  };

  if (role === 'scout') {
    return SCOUT_BODY;
  }
  if (energy <= 300 && role !== 'defender' && role !== 'supplier') {
    return BASIC_HARVESTER;
  }
  const configs = bodyConfigs[role] || bodyConfigs.harvester;
  return getBestBody(configs, energy);

  function getBestBody(bodyTiers, availableEnergy) {
    const tiers = Object.keys(bodyTiers).map(Number).sort((a, b) => a - b);
    let bestTier = tiers[0];
    for (const tier of tiers) {
      if (availableEnergy >= tier) bestTier = tier;
      else break;
    }
    return bodyTiers[bestTier];
  }
};

function spawnCreepInRoom(role, body, spawn, roomName) {
  const newName         = `${role}_${roomName}_${Game.time}`;
  const memory          = { role: role, assignedRoom: roomName };
  const availableEnergy = spawn.room.energyAvailable;
  const cost            = bodyCost(body);
  const result          = spawn.spawnCreep(body, newName, { memory: memory });

  if(result === OK) {
    console.log(`Spawning ${role} in ${roomName} with ${body.length} parts | Cost: ${cost} | Energy before: ${availableEnergy}`);
    return true;
  } else {
    if (result !== ERR_BUSY) {
      console.log(`Failed to spawn ${role} in ${roomName}: ${result} (energy: ${availableEnergy}, cost: ${cost})`);
    }
    return false;
  }
}

function getRoomTargets(roomName, roomData, room) {
  const sourcesCount = roomData.sources ? roomData.sources.length : 2;
  const harvesters = _.filter(Game.creeps, c => {
    if (c.memory.role !== 'harvester') return false;
    const assignedRoom = c.memory.homeRoom || c.memory.assignedRoom || c.room.name;
    return assignedRoom === roomName;
  });
  const totalBodyParts = harvesters.reduce((sum, c) => sum + c.body.length, 0);
  const avgBodyParts   = harvesters.length > 0 ? totalBodyParts / harvesters.length : 0;
  const X = avgBodyParts <= 6 ? 2 : 1;
  const harvesterTarget = Math.max(X, sourcesCount * X);

  const containers            = room.find(FIND_STRUCTURES, {
    filter: { structureType: STRUCTURE_CONTAINER }
  });
  const storage               = room.storage;
  const hasStorageStructures  = containers.length > 0 || !!storage;

  const builderJobs = countBuilderJobs(room);
  let builderTarget = 0;
  if (builderJobs > 0) {
    //builderTarget = 1 + Math.floor((builderJobs - 1) / 10);
    builderTarget = 1; //Save CPU temp rule
  }

  let upgraderTarget = 1;
  let storedEnergy   = storage ? (storage.store[RESOURCE_ENERGY] || 0) : 0;
  if (storedEnergy > 950000)      upgraderTarget += 8;
  else if (storedEnergy > 900000) upgraderTarget += 4;
  else if (storedEnergy > 750000) upgraderTarget += 2;
  else if (storedEnergy > 600000) upgraderTarget += 1;

  return {
    harvester:   harvesterTarget,
    upgrader:    upgraderTarget,
    builder:     builderTarget,
    scout:       0,
    defender:    0,
    supplier:    hasStorageStructures ? 1 : 0 //hasStorageStructures ? sourcesCount : 0
  };
}

function cleanMemory() {
  for (const name in Memory.creeps) {
    if (!Game.creeps[name]) {
      const creepMemory = Memory.creeps[name]; // Get memory before deleting

      // --- Thief operation cancellation logic ---
      if (creepMemory.role === 'thief') {
        if (Memory.thiefOrders) {
          const orderIndex = Memory.thiefOrders.findIndex(o =>
            o.targetRoom === creepMemory.targetRoom && o.homeRoom === creepMemory.homeRoom
          );
          if (orderIndex > -1) {
            console.log(`[Thief] A thief for operation against ${creepMemory.targetRoom} has died. Cancelling the operation.`);
            Memory.thiefOrders.splice(orderIndex, 1);
          }
        }
      }
      // --- End of thief logic ---
      // Add this in the cleanMemory function after the thief logic
      // --- Demolition operation cleanup logic ---
        if (creepMemory.role === 'demolition') {
            if (Memory.demolitionOrders) {
                const orderIndex = Memory.demolitionOrders.findIndex(o =>
                    o.targetRoom === creepMemory.targetRoom && o.homeRoom === creepMemory.homeRoom
                );
                if (orderIndex > -1 && creepMemory.demolitionRole === 'demolisher') {
                    console.log(`[Demolition] A demolisher for operation against ${creepMemory.targetRoom} has died. Keeping operation active for respawn.`);
                }
            }
        }

        if (creepMemory.role === 'towerDrain') {
            if (Memory.towerDrainOrders) {
                const orderIndex = Memory.towerDrainOrders.findIndex(o =>
                    o.targetRoom === creepMemory.targetRoom && o.homeRoom === creepMemory.homeRoom
                );
                if (orderIndex > -1) {
                    console.log(`[TowerDrain] A tower drain bot for ${creepMemory.targetRoom} has died. Keeping operation active.`);
                    // Don't remove the order, let it respawn
                }
            }
        }

        // --- Squad member cleanup ---
        if (creepMemory.role === 'squadMember') {
            if (Memory.squadPackingAreas && creepMemory.squadId) {
                // Clean up packing area if squad is decimated
                const remainingMembers = _.filter(Game.creeps, c => 
                    c.memory.role === 'squadMember' && 
                    c.memory.squadId === creepMemory.squadId
                );
                if (remainingMembers.length <= 1) { // Only this dying creep left
                    delete Memory.squadPackingAreas[creepMemory.squadId];
                    console.log(`[Squad] Squad ${creepMemory.squadId} eliminated. Cleaning up packing area.`);
                }
            }
        }

      delete Memory.creeps[name];
    }
  }
}

function getPerRoomRoleCounts() {
  const perRoomCounts = {};
  for(const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if(room.controller && room.controller.my) {
      perRoomCounts[roomName] = {
        harvester: 0,
        upgrader: 0,
        builder: 0,
        scout: 0,
        defender: 0,
        supplier: 0,
        claimbot: 0,
        attacker: 0,
        scavenger: 0,
        thief: 0,
        squadMember: 0,
        towerDrain: 0,
        demolition: 0
      };
    }
  }
  for(const name in Game.creeps) {
    const creep        = Game.creeps[name];
    const role         = creep.memory.role;
    const assignedRoom = creep.memory.homeRoom || creep.memory.assignedRoom || creep.room.name;
    if(perRoomCounts[assignedRoom] && perRoomCounts[assignedRoom][role] !== undefined) {
      perRoomCounts[assignedRoom][role]++;
    }
  }
  return perRoomCounts;
}

function cacheRoomData() {
  if(!Memory.roomData) Memory.roomData = {};
  const cache = {};
  for(const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if(!room.controller || !room.controller.my) continue;
    const shouldUpdate = !Memory.roomData[roomName] || Game.time % 100 === 0;
    if(shouldUpdate) {
      if(!Memory.roomData[roomName]) Memory.roomData[roomName] = {};
      const roomMemory = Memory.roomData[roomName];
      const sources    = room.find(FIND_SOURCES);
      roomMemory.sources               = sources.map(s => s.id);
      roomMemory.constructionSitesCount= room.find(FIND_CONSTRUCTION_SITES).length;
      roomMemory.energyCapacity        = room.energyCapacityAvailable;
      roomMemory.energyAvailable       = room.energyAvailable;
      roomMemory.spawnIds              = room.find(FIND_MY_SPAWNS).map(s => s.id);
      roomMemory.extensionIds          = room.find(FIND_MY_STRUCTURES, {
        filter: { structureType: STRUCTURE_EXTENSION }
      }).map(s => s.id);
      const storage = room.storage;
      roomMemory.storageId             = storage ? storage.id : null;
      roomMemory.containerIds          = room.find(FIND_STRUCTURES, {
        filter: { structureType: STRUCTURE_CONTAINER }
      }).map(s => s.id);
    }
    cache[roomName] = Memory.roomData[roomName];
  }
  return cache;
}

function needsNewCreeps(perRoomRoleCounts) {
  for(const roomName in perRoomRoleCounts) {
    const counts      = perRoomRoleCounts[roomName];
    const totalCreeps = Object.values(counts).reduce((sum, count) => sum + count, 0);
    if(counts.harvester === 0) return true;
    if(totalCreeps < 3) return true;
  }
  return false;
}

function countBuilderJobs(room) {
  const hasTower = room.find(FIND_MY_STRUCTURES, {
    filter: { structureType: STRUCTURE_TOWER }
  }).length > 0;
  let total = 0;
  for (let prio of PRIORITIES) {
    if (hasTower && prio.type !== 'build') continue;
    let targets = prio.targetFinder
      ? prio.targetFinder(room)
      : room.find(FIND_STRUCTURES, { filter: prio.filter });
    total += targets.length;
  }
  return total;
}

// =================================================================
// === STATUS & TRACKING FUNCTIONS =================================
// =================================================================

function displayStatus(perRoomRoleCounts) {
  const GCL_WINDOW   = 5000;
  const GCL_INTERVAL = 50;
  const TICK_WINDOW  = 500;
  let gclEta = null;

  // ─── Global Control Level (GCL) tracking ────────────────────────────────────
  if (!Memory.gclTracker) {
    Memory.gclTracker = { history: [] };
  }

  if (Game.time % GCL_INTERVAL === 0) {
    const currentPercent = Game.gcl.progress / Game.gcl.progressTotal * 100;
    Memory.gclTracker.history.push({ tick: Game.time, percent: currentPercent });

    // Prune old entries
    while (
      Memory.gclTracker.history.length > 0 &&
      Memory.gclTracker.history[0].tick < Game.time - GCL_WINDOW
    ) {
      Memory.gclTracker.history.shift();
    }

    if (Memory.gclTracker.history.length > 1) {
      const hist    = Memory.gclTracker.history;
      const oldest  = hist[0];
      const newest  = hist[hist.length - 1];
      const dt      = newest.tick - oldest.tick;
      const dPerc   = newest.percent - oldest.percent;
      let etaString = '';

      if (dPerc > 0) {
        const rate      = dPerc / dt;
        const remaining = 100 - newest.percent;
        const etaTicks  = Math.ceil(remaining / rate);
        const totalSec  = etaTicks * 4; // 1 tick = 4s

        // Breakdown into days, hours, minutes
        const days    = Math.floor(totalSec / 86400);
        const hours   = Math.floor((totalSec % 86400) / 3600);
        const minutes = Math.floor((totalSec % 3600) / 60);

        gclEta = { days, hours, minutes };
        etaString = ` | ETA: ${etaTicks} ticks (~${days}d ${hours}h ${minutes}m)`;
      } else {
        etaString = ' | ETA: ∞ (no progress)';
      }

      console.log(
        `Global Control Level: ${Game.gcl.level}` +
        ` - Progress: ${newest.percent.toFixed(2)}%${etaString}`
      );
    } else {
      console.log(
        `Global Control Level: ${Game.gcl.level}` +
        ` - Progress: ${currentPercent.toFixed(2)}%`
      );
    }
  }

  // ─── Per-room creep statistics ─────────────────────────────────────────────
  const perRoomStats = {};
  for (const name in Game.creeps) {
    const creep        = Game.creeps[name];
    const assignedRoom = creep.memory.homeRoom
                       || creep.memory.assignedRoom
                       || creep.room.name;

    if (!perRoomStats[assignedRoom]) {
      perRoomStats[assignedRoom] = {
        totalBodyParts: 0,
        totalCreeps:    0,
        totalTTL:       0,
        oldestCreepTTL: Infinity
      };
    }

    const stats = perRoomStats[assignedRoom];
    stats.totalBodyParts += creep.body.length;
    stats.totalCreeps++;
    if (creep.ticksToLive) {
      stats.totalTTL += creep.ticksToLive;
      if (creep.ticksToLive < stats.oldestCreepTTL) {
        stats.oldestCreepTTL = creep.ticksToLive;
      }
    }
  }

  console.log(`=== COLONY STATUS ===`);
  for (const roomName in perRoomRoleCounts) {
    const counts = perRoomRoleCounts[roomName];
    const stats  = perRoomStats[roomName] || {
      totalBodyParts: 0,
      totalCreeps:    0,
      totalTTL:       0,
      oldestCreepTTL: 0
    };

    const avgBodyParts = stats.totalCreeps > 0
      ? (stats.totalBodyParts / stats.totalCreeps).toFixed(1)
      : 0;
    const avgTTL = stats.totalCreeps > 0
      ? Math.round(stats.totalTTL / stats.totalCreeps)
      : 0;

    console.log(
      `${roomName}: 🧑‍🌾${counts.harvester}` +
      ` ⚡${counts.upgrader}` +
      ` 🔨${counts.builder}` +
      ` 🔭${counts.scout}` +
      ` 🛡${counts.defender}` +
      ` ⚔️${counts.attacker}` +
      ` 🦹${counts.thief}` +
      ` 🔋${counts.supplier}` +
      ` 🚀${counts.squadMember}` +
      ` | Avg Parts: ${avgBodyParts}` +
      ` | Avg TTL: ${avgTTL}`
    );
  }

  // ─── CPU & Energy ─────────────────────────────────────────────────────────
  const perfData      = getPerformanceData();
  const currentEnergy = calculateTotalEnergy();
  console.log(`💰 Total Energy: ${currentEnergy}`);

  if (!ENABLE_CPU_LOGGING || !DISABLE_CPU_CONSOLE) {
    // Calculate CPU bucket percentage (bucket max is 10,000)
    const bucketPercent = Math.round((Game.cpu.bucket / 10000) * 100);
    const bucketStatus = Game.cpu.bucket >= 10000 ? '(FULL)' : `(${bucketPercent}%)`;

    console.log(
      `🖥️ CPU: ${Math.round(perfData.cpuUsed)}/${perfData.cpuLimit}` +
      ` (${Math.round(perfData.cpuPercent)}%) | Avg: ${Math.round(perfData.cpuAverage)}` +
      ` | Bucket: ${Game.cpu.bucket}/10000 ${bucketStatus}` +
      ` | Tick Limit: ${Game.cpu.tickLimit}`
    );
  }

  // ─── Per-room RCL tracking ────────────────────────────────────────────────
  if (!Memory.progressTracker) {
    Memory.progressTracker = {};
  }

  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;

    const percent       = room.controller.progress / room.controller.progressTotal * 100;
    const energyPercent = room.energyAvailable / room.energyCapacityAvailable * 100;

    if (!Memory.progressTracker[roomName]) {
      Memory.progressTracker[roomName] = { level: room.controller.level, history: [] };
    }

    const tracker = Memory.progressTracker[roomName];
    if (tracker.level !== room.controller.level) {
      tracker.level   = room.controller.level;
      tracker.history = [{ tick: Game.time, percent }];
    }

    tracker.history.push({ tick: Game.time, percent });
    while (
      tracker.history.length > 0 &&
      tracker.history[0].tick < Game.time - TICK_WINDOW
    ) {
      tracker.history.shift();
    }

    let etaString = '';
    if (tracker.history.length > 1) {
      const hist         = tracker.history;
      const oldest       = hist[0];
      const newest       = hist[hist.length - 1];
      const tickDelta    = newest.tick - oldest.tick;
      const percentDelta = newest.percent - oldest.percent;

      if (tickDelta >= TICK_WINDOW && percentDelta > 0) {
        const percentRemaining = 100 - newest.percent;
        const rate             = percentDelta / tickDelta;
        const etaTicks         = Math.ceil(percentRemaining / rate);
        const etaMinutes       = etaTicks * 4 / 60;
        etaString = ` | ETA: ${etaTicks} ticks (~${formatTime(etaMinutes)})`;
      }
      else if (tickDelta >= TICK_WINDOW) {
        etaString = ' | ETA: ∞ (no progress)';
      }
    }

    console.log(
      `Room ${roomName}: RCL ${room.controller.level}` +
      ` - Progress: ${percent.toFixed(1)}%` +
      ` | Energy: ${room.energyAvailable}/${room.energyCapacityAvailable}` +
      ` (${energyPercent.toFixed(1)}%)${etaString}`
    );
  }

  // ─── Exploration summary ──────────────────────────────────────────────────
  if (Memory.exploration && Memory.exploration.rooms) {
    console.log(`Explored rooms: ${Object.keys(Memory.exploration.rooms).length}`);
  }

  // Return the GCL ETA breakdown (or null if unavailable)
  return gclEta;
}


function calculateTotalEnergy() {
  let totalEnergy = 0;
  if (!Memory.roomData) return 0;

  for (const roomName in Memory.roomData) {
    const roomCache = Memory.roomData[roomName];
    if (!roomCache) continue;
    const allIds = [
      ...(roomCache.spawnIds || []),
      ...(roomCache.extensionIds || []),
      ...(roomCache.containerIds || [])
    ];
    if (roomCache.storageId) {
      allIds.push(roomCache.storageId);
    }
    totalEnergy += allIds.reduce((sum, id) => {
      const structure = Game.getObjectById(id);
      if (structure && structure.store) {
        return sum + structure.store.getUsedCapacity(RESOURCE_ENERGY);
      }
      return sum;
    }, 0);
  }

  return totalEnergy;
}

function getPerformanceData() {
  const cpuUsed    = Game.cpu.getUsed();
  const cpuAverage = (Memory.cpuStats && Memory.cpuStats.average) ? Memory.cpuStats.average : 0;
  const cpuLimit   = Game.cpu.limit;
  const cpuPercent = ((cpuUsed / cpuLimit) * 100).toFixed(1);

  return {
    cpuUsed,
    cpuAverage: Math.round(cpuAverage),
    cpuPercent,
    cpuLimit,
  };
}

function formatTime(totalMinutes) {
  const days    = Math.floor(totalMinutes / (24 * 60));
  const hours   = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = Math.floor(totalMinutes % 60);
  if (days > 0) {
    return hours > 0
      ? `${days}d ${hours}h ${minutes}m`
      : `${days}d ${minutes}m`;
  } else if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else {
    return `${minutes}m`;
  }
}

function trackCPUUsage() {
  if(!Memory.cpuStats) {
    Memory.cpuStats = {
      history: [],
      average: 0
    };
  }
  const cpuUsed = Game.cpu.getUsed();
  Memory.cpuStats.history.push(cpuUsed);
  if(Memory.cpuStats.history.length > 50) {
    Memory.cpuStats.history.shift();
  }
  Memory.cpuStats.average = Memory.cpuStats.history.reduce((sum, cpu) => sum + cpu, 0)
                            / Memory.cpuStats.history.length;
}

// =================================================================
// ========================= MAIN GAME LOOP ========================
// =================================================================

module.exports.loop = function() {
  profiler.wrap(function() {
    // --- MEMORY & SYSTEM MANAGEMENT ---
    if (!Memory.stats) Memory.stats = {};
    roleScout.handleDeadCreeps();
    if (Game.time % 20 === 0)   cleanMemory();
    if (Game.time % 1000 === 0) cleanCpuProfileMemory();

    // --- CACHING & COUNTS ---
    const perRoomRoleCounts = getPerRoomRoleCounts();
    const roomDataCache     = cacheRoomData();

    // --- STRUCTURES ---
    profileSection('runTowers', runTowers);
    if (Game.time % 5 === 0) {
      profileSection('runLinks', runLinks);
    }
    
        // In your main loop, replace the grouped spawn calls with individual profiling:
        // Add these to your main loop profiling
    profileSection('cleanMemory', cleanMemory);
    profileSection('getPerRoomRoleCounts', () => getPerRoomRoleCounts());
    profileSection('cacheRoomData', () => cacheRoomData());
    profileSection('manageClaimbotSpawns', manageClaimbotSpawns);
    profileSection('manageAttackerSpawns', manageAttackerSpawns);
    profileSection('manageTowerDrainSpawns', manageTowerDrainSpawns);
    profileSection('manageThiefSpawns', manageThiefSpawns);
    profileSection('manageExtractorSpawns', manageExtractorSpawns);
    profileSection('manageDemolitionSpawns', manageDemolitionSpawns);


    // --- SQUAD MANAGEMENT ---
    profileSection('processSquadSpawnQueues', processSquadSpawnQueues);

    // --- SPAWNING ---
    profileSection('manageDemolitionSpawns', manageDemolitionSpawns);
    if (Game.time % 10 === 0) profileSection('manageClaimbotSpawns', manageClaimbotSpawns);
    if (Game.time % 5 === 0)  profileSection('manageAttackerSpawns', manageAttackerSpawns);
    profileSection('manageTowerDrainSpawns', manageTowerDrainSpawns);
    profileSection('manageThiefSpawns',       manageThiefSpawns);
    if (Game.time % 50 === 0) profileSection('manageExtractorSpawns', manageExtractorSpawns);
    if (Game.time % 10 === 0) profileSection('spawnScavengers', spawnScavengers);

    if (needsNewCreeps(perRoomRoleCounts) || Game.time % 10 === 0) {
      profileSection('manageSpawnsPerRoom', () => {
        manageSpawnsPerRoom(perRoomRoleCounts, roomDataCache);
      });
    }

    // --- CREEP ACTIONS ---
    profileSection('runCreeps', runCreeps);

    // --- TRACKING & VISUALS ---
    profileSection('trackCPUUsage', trackCPUUsage);

    // --- STATUS DISPLAY (LESS OFTEN) ---
    if (Game.time % 50 === 0) {
      profileSection('displayStatus', () => displayStatus(perRoomRoleCounts));
      if (ENABLE_CPU_LOGGING && !DISABLE_CPU_CONSOLE) {
        for (const key in Memory.cpuProfile) {
          const avg = Memory.cpuProfile[key].reduce((a, b) => a + b, 0) / Memory.cpuProfile[key].length;
          console.log(`CPU Profile: ${key} avg: ${Math.round(avg)}`);
        }
      }
    }
  });
};
