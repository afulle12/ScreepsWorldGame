// LLM: Read llmcontext.js before reviewing or changing this file.
//orderSign('W1N1', 'W2N2', 'Hello from my colony!')

const getRoomState = require('getRoomState');
const spawnManager = require('spawnManager');

const roleSignbot = {
    run: function(creep) {
        // If we don't have a target room or message, something went wrong
        if (!creep.memory.targetRoom || !creep.memory.signMessage) {
            console.log(`[Signbot] ${creep.name} has no target room or message. Suiciding.`);
            creep.suicide();
            return;
        }

        // If we're not in the target room, move there
        if (creep.room.name !== creep.memory.targetRoom) {
            const exitDir = Game.map.findExit(creep.room, creep.memory.targetRoom);
            if (exitDir === ERR_NO_PATH || exitDir === ERR_INVALID_ARGS) {
                console.log(`[Signbot] ${creep.name} cannot find path to ${creep.memory.targetRoom}`);
                creep.suicide();
                return;
            }

            const exit = creep.pos.findClosestByRange(exitDir);
            if (exit) {
                creep.moveTo(exit, { visualizePathStyle: { stroke: '#00ff00' } });
                creep.say('🚀 Moving');
            }
            return;
        }

        // We're in the target room, find the controller
        const controller = creep.room.controller;
        if (!controller) {
            console.log(`[Signbot] ${creep.name} found no controller in ${creep.memory.targetRoom}`);
            creep.suicide();
            return;
        }

        // Move to the controller and sign it
        if (!creep.pos.inRangeTo(controller, 1)) {
            creep.moveTo(controller, { visualizePathStyle: { stroke: '#ffaa00' } });
            creep.say('📝 Signing');
        } else {
            const result = creep.signController(controller, creep.memory.signMessage);
            if (result === OK) {
                console.log(`[Signbot] ${creep.name} successfully signed ${creep.memory.targetRoom} with: "${creep.memory.signMessage}"`);
                creep.say('✅ Done');
                creep.suicide(); // Job complete
            } else {
                console.log(`[Signbot] ${creep.name} failed to sign controller: ${result}`);
                creep.suicide();
            }
        }
    }
};

module.exports = roleSignbot;

global.orderSign = function(spawnRoom, targetRoom, message) {
  if (!spawnRoom || !targetRoom || !message) {
    return "[Signbot] Invalid command. Use: orderSign('spawnRoomName', 'targetRoomName', 'message')";
  }
  if (!Game.rooms[spawnRoom] || !Game.rooms[spawnRoom].controller || !Game.rooms[spawnRoom].controller.my) {
    return "[Signbot] Invalid spawn room: " + spawnRoom + ". Must be a room you own.";
  }

  var rs = getRoomState.get(spawnRoom);
  var freeSpawns = [];
  if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
    freeSpawns = rs.structuresByType[STRUCTURE_SPAWN].filter(function(s){ return s.my && !s.spawning; });
  } else {
    freeSpawns = Game.rooms[spawnRoom].find(FIND_MY_SPAWNS, { filter: function(s){ return !s.spawning; } });
  }
  if (freeSpawns.length === 0) {
    return "[Signbot] No available spawn in " + spawnRoom;
  }

  var body = [MOVE];
  var cost = spawnManager.bodyCost(body);
  if (cost > freeSpawns[0].room.energyAvailable) {
    return "[Signbot] Not enough energy in " + spawnRoom + ". Need: " + cost + ", Have: " + freeSpawns[0].room.energyAvailable;
  }

  var name = "Signbot_" + targetRoom + "_" + Game.time;
  var memory = { role: 'signbot', targetRoom: targetRoom, signMessage: message };

  var result = spawnManager.spawnCustomCreep(freeSpawns[0], body, name, memory);
  if (result === OK) {
    console.log("[Signbot] Spawning '" + name + "' from " + spawnRoom + " to sign " + targetRoom + " with: \"" + message + "\"");
    return "[Signbot] Successfully ordered signbot from " + spawnRoom + " to " + targetRoom;
  } else {
    return "[Signbot] Failed to spawn signbot: " + result;
  }
};
