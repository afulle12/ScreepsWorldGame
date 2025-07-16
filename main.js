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

// --- CONSTANTS ---
const BASIC_HARVESTER = [WORK, WORK, CARRY, MOVE];
const BASIC_DEFENDER   = [TOUGH, MOVE, RANGED_ATTACK];
const SCOUT_BODY       = [MOVE, MOVE, MOVE, MOVE, MOVE];
const SCAVENGER_BODY = [MOVE, CARRY, CARRY, MOVE];

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
      ![STRUCTURE_ROAD, STRUCTURE_CONTAINER, STRUCTURE_WALL, STRUCTURE_RAMPART].includes(s.structureType) &&
      (s.hits / s.hitsMax < 0.75) &&
      (s.hits / s.hitsMax >= 0.25) &&
      s.hits < s.hitsMax,
    label: 'Repair Other <75%',
    need: s => `${s.hits}/${s.hitsMax}`,
    urgency: s => s.hits,
  },
  {
    type: 'reinforce',
    filter: s =>
      (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) &&
      s.hits < 20000,
    label: 'Reinforce <20k',
    need: s => `${s.hits}/20000`,
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

global.orderAttack = function(targetRoom, count) {
  if (!targetRoom || !count || count <= 0) {
    return `[Attack] Invalid order. Use global.orderAttack('roomName', creepCount).`;
  }
  if (!Memory.attackOrders) {
    Memory.attackOrders = [];
  }
  Memory.attackOrders.push({ targetRoom: targetRoom, count: count });
  return `[Attack] Order placed for ${count} attackers to be sent to ${targetRoom}.`;
};

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

    const tickMod5 = (Game.time % 5) === 0;

    for (const tower of towers) {
      const mem = Memory.towerTargets[tower.id] ||
                 (Memory.towerTargets[tower.id] = { targetId: null, lastHp: 0, sameHp: 0 });

      let target = null;
      if (healers.length)          target = tower.pos.findClosestByRange(healers);
      else if (hostiles.length)    target = tower.pos.findClosestByRange(hostiles);

      if (target) {
        if (mem.targetId === target.id) {
          mem.sameHp = (mem.lastHp === target.hits) ? mem.sameHp + 1 : 0;
        } else {
          mem.targetId = target.id;
          mem.sameHp   = 0;
        }
        mem.lastHp = target.hits;

        if (mem.sameHp >= 5) {
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
                         s.hits < 2000000
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
  const order          = Memory.attackOrders[0];
  const targetRoom     = order.targetRoom;
  const requiredCount  = order.count;
  const existingAttackers = _.filter(
    Game.creeps,
    c => c.memory.role === 'attacker' && c.memory.targetRoom === targetRoom
  );

  if (existingAttackers.length >= requiredCount) {
    console.log(`[Attack] Attack order for ${targetRoom} is fulfilled. Removing order.`);
    Memory.attackOrders.shift();
    return;
  }

  let bestSpawn   = null;
  let minDistance = Infinity;
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!room.controller || !room.controller.my) continue;
    const spawns = room.find(FIND_MY_SPAWNS, { filter: s => !s.spawning });
    if (spawns.length === 0) continue;
    const distance = Game.map.getRoomLinearDistance(roomName, targetRoom);
    if (distance < minDistance) {
      minDistance = distance;
      bestSpawn   = spawns[0];
    }
  }

  if (!bestSpawn) return;
  const body = getCreepBody('attacker', bestSpawn.room.energyAvailable);
  if (!body || bodyCost(body) > bestSpawn.room.energyAvailable) return;

  const newName = `Attacker_${targetRoom}_${Game.time % 1000}`;
  const memory  = { role: 'attacker', targetRoom: targetRoom, homeRoom: bestSpawn.room.name };
  const result  = bestSpawn.spawnCreep(body, newName, { memory: memory });
  if (result === OK) {
    console.log(`[Attack] Spawning '${newName}' from ${bestSpawn.room.name} for mission to ${targetRoom}.`);
  }
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
      200: [CARRY, CARRY, MOVE, MOVE],
      300: [CARRY, CARRY, CARRY, MOVE, MOVE, MOVE],
      400: [CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE],
      600: [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      900: [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
      1000:[CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE]
    },
    scout:   { 300: SCOUT_BODY },
    attacker:{
      360:  [TOUGH, TOUGH, MOVE, MOVE, ATTACK, ATTACK],
      600:  [TOUGH, TOUGH, TOUGH, TOUGH, MOVE, MOVE, MOVE, MOVE, ATTACK, ATTACK, ATTACK, ATTACK],
      1080: [TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE,
             ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK]
    }
  };

  if (role === 'scout') {
    return SCOUT_BODY;
  }
  if (energy <= 300 && role !== 'defender' && role !== 'supplier' && role !== 'attacker') {
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
}

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
    supplier:    hasStorageStructures ? sourcesCount : 0
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
        thief: 0
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
  const GCL_INTERVAL = 500;
  if (!Memory.gclTracker) {
    Memory.gclTracker = { history: [] };
  }
  if (Game.time % GCL_INTERVAL === 0) {
    const currentPercent = Game.gcl.progress / Game.gcl.progressTotal * 100;
    Memory.gclTracker.history.push({ tick: Game.time, percent: currentPercent });
    while (Memory.gclTracker.history.length > 0 &&
           Memory.gclTracker.history[0].tick < Game.time - GCL_WINDOW) {
      Memory.gclTracker.history.shift();
    }
    if (Memory.gclTracker.history.length > 1) {
      const oldest  = Memory.gclTracker.history[0];
      const newest  = Memory.gclTracker.history[Memory.gclTracker.history.length - 1];
      const dt      = newest.tick - oldest.tick;
      const dPerc   = newest.percent - oldest.percent;
      let etaString = '';
      if (dPerc > 0) {
        const rate        = dPerc / dt;
        const remaining   = 100 - newest.percent;
        const etaTicks    = Math.ceil(remaining / rate);
        const totalSec    = etaTicks * 4;
        const h           = Math.floor(totalSec / 3600);
        const m           = Math.floor((totalSec % 3600) / 60);
        const s           = totalSec % 60;
        const humanTime   = `${h}h ${m}m ${s}s`;
        etaString = ` | ETA: ${etaTicks} ticks (~${humanTime})`;
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

  const TICK_WINDOW = 500;
  const perRoomStats = {};

  for(const name in Game.creeps) {
    const creep        = Game.creeps[name];
    const assignedRoom = creep.memory.homeRoom || creep.memory.assignedRoom || creep.room.name;
    if(!perRoomStats[assignedRoom]) {
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
    if(creep.ticksToLive) {
      stats.totalTTL += creep.ticksToLive;
      if (creep.ticksToLive < stats.oldestCreepTTL) {
        stats.oldestCreepTTL = creep.ticksToLive;
      }
    }
  }

  console.log(`=== COLONY STATUS ===`);
  for(const roomName in perRoomRoleCounts) {
    const counts = perRoomRoleCounts[roomName];
    const stats  = perRoomStats[roomName] || {
      totalBodyParts: 0,
      totalCreeps: 0,
      oldestCreepTTL: 0,
      totalTTL: 0
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
      ` | Avg Parts: ${avgBodyParts}` +
      ` | Avg TTL: ${avgTTL}`
    );
  }

  const perfData     = getPerformanceData();
  const currentEnergy= calculateTotalEnergy();
  console.log(`💰 Total Energy: ${currentEnergy}`);

  if (!ENABLE_CPU_LOGGING || !DISABLE_CPU_CONSOLE) {
    console.log(`🖥️ CPU: ${Math.round(perfData.cpuUsed)}/${perfData.cpuLimit} (${Math.round(perfData.cpuPercent)}%) | Avg: ${Math.round(perfData.cpuAverage)}`);
  }

  for(const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if(room.controller && room.controller.my) {
      const percent       = (room.controller.progress / room.controller.progressTotal * 100);
      const progress      = percent.toFixed(1);
      const energyPercent = (room.energyAvailable / room.energyCapacityAvailable * 100).toFixed(1);

      if(!Memory.progressTracker) Memory.progressTracker = {};
      if(!Memory.progressTracker[roomName]) Memory.progressTracker[roomName] = {};
      const tracker = Memory.progressTracker[roomName];

      if(tracker.level !== room.controller.level) {
        tracker.level   = room.controller.level;
        tracker.history = [{ tick: Game.time, percent: percent }];
      }
      if(!tracker.history) tracker.history = [];
      tracker.history.push({ tick: Game.time, percent: percent });
      while(tracker.history.length > 0 && tracker.history[0].tick < Game.time - TICK_WINDOW) {
        tracker.history.shift();
      }

      let etaString = '';
      if(tracker.history.length > 1) {
        const oldest      = tracker.history[0];
        const newest      = tracker.history[tracker.history.length - 1];
        const tickDelta   = newest.tick - oldest.tick;
        const percentDelta= newest.percent - oldest.percent;
        if(tickDelta >= TICK_WINDOW && percentDelta > 0) {
          const percentRemaining = 100 - newest.percent;
          const rate             = percentDelta / tickDelta;
          const etaTicks         = Math.ceil(percentRemaining / rate);
          const etaMinutes       = etaTicks * 4 / 60;
          etaString = ` | ETA: ${etaTicks} ticks (~${formatTime(etaMinutes)})`;
        } else if(tickDelta >= TICK_WINDOW && percentDelta <= 0) {
          etaString = ' | ETA: ∞ (no progress)';
        }
      }

      console.log(
        `Room ${roomName}: RCL ${room.controller.level}` +
        ` - Progress: ${progress}%` +
        ` | Energy: ${room.energyAvailable}/${room.energyCapacityAvailable}` +
        ` (${energyPercent}%)${etaString}`
      );
    }
  }

  if(Memory.exploration && Memory.exploration.rooms) {
    console.log(`Explored rooms: ${Object.keys(Memory.exploration.rooms).length}`);
  }
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

  // --- SPAWNING ---
  if (Game.time % 10 === 0) profileSection('manageClaimbotSpawns', manageClaimbotSpawns);
  if (Game.time % 5 === 0)  profileSection('manageAttackerSpawns', manageAttackerSpawns);
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
};
