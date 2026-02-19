// ===============================
// Global Orders Module
// Register all console/global commands here.
// This module depends on: getRoomState, iff, squad, getCreepBody, bodyCost
// ===============================

module.exports = {
  init: function(deps) {
    var getRoomState = deps && deps.getRoomState ? deps.getRoomState : null;
    var iff          = deps && deps.iff ? deps.iff : null;
    var squad        = deps && deps.squad ? deps.squad : null;
    var getCreepBody = deps && deps.getCreepBody ? deps.getCreepBody : null;
    var bodyCost     = deps && deps.bodyCost ? deps.bodyCost : null;

    function ensureDeps(names) {
      for (var i = 0; i < names.length; i++) {
        var n = names[i];
        if (!n.value) return n.name;
      }
      return null;
    }

    // --- CONSOLE COMMANDS ---
    global.roomBalanceNextRun = function() {
      var interval = 5000;
      var mod = Game.time % interval;
      var delta = (mod === 0) ? 0 : (interval - mod);
      var next = Game.time + delta;
      console.log('[roomBalance] next auto run at tick ' + next +
                  ' (in ' + delta + ' ticks, now=' + Game.time + ', interval=' + interval + ')');
      return { nextTick: next, inTicks: delta, now: Game.time, interval: interval };
    };

    global.orderWallRepair = function(roomName, threshold) {
      var missing = ensureDeps([{ name: 'getRoomState', value: getRoomState }]);
      if (missing) return "[WallRepair] Missing dependency: " + missing;

      if (!roomName || typeof threshold !== 'number' || threshold <= 0) {
        return "[WallRepair] Usage: orderWallRepair('roomName', thresholdHits)";
      }
      var room = Game.rooms[roomName];
      if (!room || !room.controller || !room.controller.my) {
        return "[WallRepair] Invalid room or not owned: " + roomName;
      }

      if (!Memory.wallRepairOrders) Memory.wallRepairOrders = {};

      var rs = getRoomState.get(roomName);
      var mySpawns = [];
      if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
        mySpawns = rs.structuresByType[STRUCTURE_SPAWN].filter(function(s){ return s.my; });
      } else {
        mySpawns = room.find(FIND_MY_SPAWNS);
      }
      var origin = room.storage || mySpawns[0];
      if (!origin) {
        return "[WallRepair] No Storage or Spawn found in " + roomName;
      }

      var walls = [];
      if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_WALL]) {
        for (var i = 0; i < rs.structuresByType[STRUCTURE_WALL].length; i++) {
          var w = rs.structuresByType[STRUCTURE_WALL][i];
          if (w.hits < threshold) walls.push(w);
        }
      } else {
        walls = room.find(FIND_STRUCTURES, {
          filter: function(s) { return s.structureType === STRUCTURE_WALL && s.hits < threshold; }
        });
      }

      walls.sort(function(a, b) {
        var da = origin.pos.getRangeTo(a.pos);
        var db = origin.pos.getRangeTo(b.pos);
        return da - db;
      });

      Memory.wallRepairOrders[roomName] = {
        roomName: roomName,
        threshold: threshold,
        originId: origin.id,
        originType: room.storage ? 'storage' : 'spawn',
        active: true,
        queue: walls.map(function(w) { return w.id; }),
        skipped: {},
        createdAt: Game.time
      };

      return "[WallRepair] Order created for " + roomName + " to " + threshold + " hits. Targets: " + walls.length;
    };

    global.cancelWallRepair = function(roomName) {
      if (!Memory.wallRepairOrders || !Memory.wallRepairOrders[roomName]) {
        return "[WallRepair] No active order for " + roomName;
      }
      delete Memory.wallRepairOrders[roomName];
      return "[WallRepair] Order cancelled for " + roomName + ". Any existing repairer will not be replaced.";
    };

    global.wallRepairStatus = function(roomName) {
      var order = Memory.wallRepairOrders && Memory.wallRepairOrders[roomName];
      if (!order) return "[WallRepair] No order for " + roomName;

      var living = _.filter(Game.creeps, function(c) {
        return c.memory && c.memory.role === 'wallRepair' && c.memory.orderRoom === roomName;
      });
      var remaining = order.queue ? order.queue.length : 0;
      return "[WallRepair] " + roomName +
             " | threshold=" + order.threshold +
             " | active=" + (order.active !== false) +
             " | remaining=" + remaining +
             " | skipped=" + Object.keys(order.skipped || {}).length +
             " | creeps=" + living.length;
    };

    global.orderThieves = function(homeRoom, targetRoom, count) {
      if (!Game.rooms[homeRoom] || !Game.rooms[homeRoom].controller || !Game.rooms[homeRoom].controller.my) {
        return '[Thief] Invalid home room: ' + homeRoom + '. Must be a room you own.';
      }
      if (!targetRoom || !count || count <= 0) {
        return "[Thief] Invalid order. Use: orderThieves('homeRoomName', 'targetRoomName', creepCount)";
      }
      if (!Memory.thiefOrders) Memory.thiefOrders = [];
      var existingOrder = Memory.thiefOrders.find(function(o){ return o.targetRoom === targetRoom; });
      if (existingOrder) {
        return "[Thief] An operation against " + targetRoom + " is already active. Cancel it first to create a new one.";
      }

      Memory.thiefOrders.push({
        homeRoom: homeRoom,
        targetRoom: targetRoom,
        count: parseInt(count, 10)
      });
      return "[Thief] Order placed for " + count + " thieves to raid " + targetRoom + " from " + homeRoom + ".";
    };

    global.cancelThiefOrder = function(targetRoom) {
      if (!targetRoom) {
        return "[Thief] Invalid command. Use: cancelThiefOrder('targetRoomName')";
      }
      if (!Memory.thiefOrders || Memory.thiefOrders.length === 0) {
        return "[Thief] No active thief orders to cancel.";
      }

      var orderIndex = Memory.thiefOrders.findIndex(function(o){ return o.targetRoom === targetRoom; });
      if (orderIndex > -1) {
        Memory.thiefOrders.splice(orderIndex, 1);
        return "[Thief] Operation against " + targetRoom + " has been cancelled. Existing thieves will not be replaced.";
      } else {
        return "[Thief] No active operation found for target room " + targetRoom + ".";
      }
    };

    global.orderDemolition = function(homeRoom, targetRoom, teamCount, focus) {
      // Optional 4th param "focus": supports 'controller' or 'wall'
      // Usage:
      // - orderDemolition('E1S1', 'E2S2', 2)                       -> normal demolition
      // - orderDemolition('E1S1', 'E2S2', 2, 'controller')         -> prioritize walls/ramparts in range 1 of controller
      // - orderDemolition('E1S1', 'E2S2', 2, 'wall')               -> dismantle ONLY STRUCTURE_WALL; mission complete when none remain
      var count = (teamCount === undefined) ? 1 : teamCount;
      if (!Game.rooms[homeRoom] || !Game.rooms[homeRoom].controller || !Game.rooms[homeRoom].controller.my) {
        return "[Demolition] Invalid home room: " + homeRoom + ". Must be a room you own.";
      }
      if (!targetRoom || count <= 0) {
        return "[Demolition] Invalid order. Use: orderDemolition('homeRoomName', 'targetRoomName', teamCount, [focus])";
      }
    
      // Validate target ownership
      var targetRoomObj = Game.rooms[targetRoom];
      if (targetRoomObj && targetRoomObj.controller && targetRoomObj.controller.owner) {
        if (iff && typeof iff.isAlly === 'function' && iff.isAlly(targetRoomObj.controller.owner.username)) {
          return "[Demolition] Cannot demolish " + targetRoom + " - it's owned by ally " + targetRoomObj.controller.owner.username;
        }
        if (targetRoomObj.controller.my) {
          return "[Demolition] Cannot demolish " + targetRoom + " - it's your own room!";
        }
      }
    
      if (!Memory.demolitionOrders) Memory.demolitionOrders = [];
      var existingOrder = Memory.demolitionOrders.find(function(o){ return o.targetRoom === targetRoom; });
      if (existingOrder) {
        return "[Demolition] An operation against " + targetRoom + " is already active. Cancel it first to create a new one.";
      }
    
      // Normalize/validate focus - FIXED to include 'wall'
      var normalizedFocus = null;
      if (typeof focus === 'string') {
        var f = focus.toLowerCase();
        if (f === 'controller') {
          normalizedFocus = 'controller';
        } else if (f === 'wall') {
          normalizedFocus = 'wall';
        }
      }
    
      Memory.demolitionOrders.push({
        homeRoom: homeRoom,
        targetRoom: targetRoom,
        teamCount: parseInt(count, 10),
        teamsSpawned: 0,
        // Optional: 'controller' prioritizes walls/ramparts adjacent to the controller
        //           'wall' dismantles ONLY STRUCTURE_WALL until none remain
        focus: normalizedFocus
      });
    
      return "[Demolition] Order placed for " + count + " demolition team(s) to demolish " + targetRoom +
             " from " + homeRoom + (normalizedFocus ? (" with focus='" + normalizedFocus + "'") : "") + ".";
    };


    global.cancelDemolitionOrder = function(targetRoom) {
      if (!targetRoom) {
        return "[Demolition] Invalid command. Use: cancelDemolitionOrder('targetRoomName')";
      }
      if (!Memory.demolitionOrders || Memory.demolitionOrders.length === 0) {
        return "[Demolition] No active demolition orders to cancel.";
      }

      var orderIndex = Memory.demolitionOrders.findIndex(function(o){ return o.targetRoom === targetRoom; });
      if (orderIndex > -1) {
        Memory.demolitionOrders.splice(orderIndex, 1);
        return "[Demolition] Operation against " + targetRoom + " has been cancelled. Existing demolition teams will not be replaced.";
      } else {
        return "[Demolition] No active operation found for target room " + targetRoom + ".";
      }
    };

    global.orderSquad = function(formRoom, attackRoom, numSquads) {
      var n = (numSquads === undefined) ? 1 : numSquads;
      if (!Game.rooms[formRoom] || !Game.rooms[formRoom].controller || !Game.rooms[formRoom].controller.my) {
        return "[Squad] Invalid form room: " + formRoom + ". Must be a room you own.";
      }
      if (!attackRoom || n <= 0) {
        return "[Squad] Invalid order. Use: orderSquad('formRoomName', 'attackRoomName', numSquads)";
      }

      if (!squad || typeof squad.spawnSquads !== 'function') {
        return "[Squad] Missing squad module.";
      }

      var targetRoomObj = Game.rooms[attackRoom];
      if (targetRoomObj && targetRoomObj.controller && targetRoomObj.controller.owner) {
        if (iff && typeof iff.isAlly === 'function' && iff.isAlly(targetRoomObj.controller.owner.username)) {
          return "[Squad] Cannot attack " + attackRoom + " - it's owned by ally " + targetRoomObj.controller.owner.username;
        }
        if (targetRoomObj.controller.my) {
          return "[Squad] Cannot attack " + attackRoom + " - it's your own room!";
        }
      }

      squad.spawnSquads(formRoom, attackRoom, n);
      return "[Squad] Order placed for " + n + " squad(s) to attack " + attackRoom + " from " + formRoom + ".";
    };

    global.cancelSquadOrder = function(attackRoom) {
      if (!attackRoom) {
        return "[Squad] Invalid command. Use: cancelSquadOrder('attackRoomName')";
      }
      if (!Memory.squadQueues || Memory.squadQueues.length === 0) {
        return "[Squad] No active squad orders to cancel.";
      }

      var initialLength = Memory.squadQueues.length;
      Memory.squadQueues = Memory.squadQueues.filter(function(q){ return q.attackRoom !== attackRoom; });

      if (Memory.squadPackingAreas) {
        for (var squadId in Memory.squadPackingAreas) {
          if (squadId.indexOf(attackRoom) !== -1) {
            delete Memory.squadPackingAreas[squadId];
          }
        }
      }

      var removed = initialLength - Memory.squadQueues.length;
      if (removed > 0) {
        return "[Squad] Cancelled " + removed + " squad queue(s) for " + attackRoom + ".";
      } else {
        return "[Squad] No active squad orders found for " + attackRoom + ".";
      }
    };

    global.orderAttack = function(targetRoom, count, rallyRoom) {
      if (!targetRoom || !count || count <= 0) {
        return "[Attack] Invalid command. Use: orderAttack('targetRoom', count, 'rallyRoom')";
      }

      if (!rallyRoom) {
        var minDistance = Infinity;
        for (var roomName in Game.rooms) {
          var room = Game.rooms[roomName];
          if (!room.controller || !room.controller.my) continue;
          var distance = Game.map.getRoomLinearDistance(roomName, targetRoom);
          if (distance < minDistance) {
            minDistance = distance;
            rallyRoom = roomName;
          }
        }
      }

      if (!Game.rooms[rallyRoom] || !Game.rooms[rallyRoom].controller || !Game.rooms[rallyRoom].controller.my) {
        return "[Attack] Invalid rally room: " + rallyRoom + ". Must be a room you control.";
      }

      if (!Memory.attackOrders) Memory.attackOrders = [];

      var existingOrder = Memory.attackOrders.find(function(o){ return o.targetRoom === targetRoom; });
      if (existingOrder) {
        return "[Attack] Attack order for " + targetRoom + " already exists!";
      }

      var rallyPoint = { x: 25, y: 25 };

      Memory.attackOrders.push({
        targetRoom: targetRoom,
        rallyRoom: rallyRoom,
        count: count,
        spawned: 0,
        startTime: Game.time,
        rallyPoint: rallyPoint,
        rallyPhase: 'spawning'
      });

      console.log("[Attack] Order created: " + count + " attackers to attack " + targetRoom + ", rally in " + rallyRoom);
      return "[Attack] Order created: " + count + " attackers to attack " + targetRoom + ", rally in " + rallyRoom;
    };

    global.orderSign = function(spawnRoom, targetRoom, message) {
      var missing = ensureDeps([{ name: 'bodyCost', value: bodyCost }]);
      if (missing) return "[Signbot] Missing dependency: " + missing;

      if (!spawnRoom || !targetRoom || !message) {
        return "[Signbot] Invalid command. Use: orderSign('spawnRoomName', 'targetRoomName', 'message')";
      }
      if (!Game.rooms[spawnRoom] || !Game.rooms[spawnRoom].controller || !Game.rooms[spawnRoom].controller.my) {
        return "[Signbot] Invalid spawn room: " + spawnRoom + ". Must be a room you own.";
      }

      var rs = getRoomState ? getRoomState.get(spawnRoom) : null;
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
      var cost = bodyCost(body);
      if (cost > freeSpawns[0].room.energyAvailable) {
        return "[Signbot] Not enough energy in " + spawnRoom + ". Need: " + cost + ", Have: " + freeSpawns[0].room.energyAvailable;
      }

      var name = "Signbot_" + targetRoom + "_" + Game.time;
      var memory = { role: 'signbot', targetRoom: targetRoom, signMessage: message };

      var result = freeSpawns[0].spawnCreep(body, name, { memory: memory });
      if (result === OK) {
        console.log("[Signbot] Spawning '" + name + "' from " + spawnRoom + " to sign " + targetRoom + " with: \"" + message + "\"");
        return "[Signbot] Successfully ordered signbot from " + spawnRoom + " to " + targetRoom;
      } else {
        return "[Signbot] Failed to spawn signbot: " + result;
      }
    };

    global.assignAttackTarget = function(roomName, targetId) {
      if (!roomName || !targetId) {
        return "[Attack] Invalid command. Use global.assignAttackTarget('roomName', 'targetId').";
      }
      var attackersInRoom = _.filter(Game.creeps, function(c){
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
    
    global.orderSquad = function(formRoom, attackRoom) {
      if (!Game.rooms[formRoom] || !Game.rooms[formRoom].controller || !Game.rooms[formRoom].controller.my) {
        return "[Squad] Invalid form room: " + formRoom;
      }
      if (!attackRoom) return "[Squad] Target room required.";

      if (!Memory.squadOrders) Memory.squadOrders = [];
      
      Memory.squadOrders.push({
          homeRoom: formRoom,
          targetRoom: attackRoom,
          spawnedCount: 0,
          squadId: "Squad_" + attackRoom + "_" + Game.time
      });

      return "[Squad] Order placed: Quad from " + formRoom + " to attack " + attackRoom;
    };
    
    global.cancelSquadOrders = function() {
        Memory.squadOrders = [];
        return "[Squad] All squad orders cleared.";
    };

    global.cancelAttackOrder = function (targetRoom) {
      if (!Memory.attackOrders || Memory.attackOrders.length === 0) return '[Attack] No active attack orders.';
      var i = Memory.attackOrders.findIndex(function(o){ return o.targetRoom === targetRoom; });
      if (i === -1) return "[Attack] No attack order found for " + targetRoom + ".";
      Memory.attackOrders.splice(i, 1);
      return "[Attack] Attack on " + targetRoom + " has been cancelled.";
    };

    global.checkLabBots = function(roomName) {
      if (!getRoomState || !getCreepBody) {
        // Still works without getRoomState; leaving as soft-dependency
      }

      if (!roomName) {
        var results = [];
        for (var rName in Game.rooms) {
          var room = Game.rooms[rName];
          if (!room.controller || !room.controller.my) continue;

          var labOrders = Memory.labOrders && Memory.labOrders[rName];
          var hasOrders = labOrders && (labOrders.active || (labOrders.queue && labOrders.queue.length > 0));
          var count = _.filter(Game.creeps, function(c) {
            return c.memory.role === 'labBot' && (c.memory.homeRoom === rName || c.memory.assignedRoom === rName || c.room.name === rName);
          }).length;

          if (hasOrders || count > 0) {
            results.push(rName + ': ' + count + ' bots, orders=' + (hasOrders ? 'YES' : 'NO'));
          }
        }
        return results.length > 0 ? results.join(' | ') : 'No LabBots or lab orders found';
      } else {
        var room = Game.rooms[roomName];
        if (!room) return 'No vision in ' + roomName;

        var labOrders = Memory.labOrders && Memory.labOrders[roomName];
        var hasOrders = labOrders && (labOrders.active || (labOrders.queue && labOrders.length > 0));
        var labBots = _.filter(Game.creeps, function(c) {
          return c.memory.role === 'labBot' && (c.memory.homeRoom === roomName || c.memory.assignedRoom === roomName || c.room.name === roomName);
        });

        var lines = [];
        lines.push('Room: ' + roomName);
        lines.push('Active orders: ' + (hasOrders ? 'YES' : 'NO'));
        lines.push('LabBots: ' + labBots.length);
        if (labBots.length > 0) {
          lines.push('Names: ' + labBots.map(function(c){ return c.name; }).join(', '));
        }

        return lines.join(' | ');
      }
    };

    global.forceSpawnLabBot = function(roomName) {
      var missing = ensureDeps([
        { name: 'getRoomState', value: getRoomState },
        { name: 'getCreepBody', value: getCreepBody }
      ]);
      if (missing) return 'Missing dependency: ' + missing;

      var room = Game.rooms[roomName];
      if (!room) return 'No vision in ' + roomName;

      var rs = getRoomState.get(roomName);
      var freeSpawn = null;
      if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
        for (var i = 0; i < rs.structuresByType[STRUCTURE_SPAWN].length; i++) {
          var sp = rs.structuresByType[STRUCTURE_SPAWN][i];
          if (sp.my && !sp.spawning) { freeSpawn = sp; break; }
        }
      } else {
        freeSpawn = room.find(FIND_MY_SPAWNS)[0];
      }
      if (!freeSpawn) return 'No spawn in ' + roomName;
      if (freeSpawn.spawning) return 'Spawn busy in ' + roomName;

      var body = getCreepBody('labBot', freeSpawn.room.energyAvailable);
      if (!body) return 'Cannot generate labBot body';

      var name = 'LabBot_' + roomName + '_' + Game.time;
      var memory = { role: 'labBot', homeRoom: roomName, assignedRoom: roomName, phase: 'buildA' };
      var result = freeSpawn.spawnCreep(body, name, { memory: memory });

      return result === OK ? 'LabBot spawn queued' : 'LabBot spawn failed: ' + result;
    };
    // ===========================================
// Remote Builder Orders (console commands)
// ===========================================

global.remoteBuilder = function(homeRoom, targetRoom, count) {
  if (!homeRoom || !targetRoom || !count || parseInt(count, 10) <= 0) {
    return "[RemoteBuilder] Invalid command. Use: remoteBuilder('homeRoom', 'targetRoom', count)";
  }

  var home = Game.rooms[homeRoom];
  if (!home || !home.controller || !home.controller.my) {
    return "[RemoteBuilder] Invalid home room: " + homeRoom + ". Must be a room you own.";
  }

  if (!Memory.remoteBuilderOrders) Memory.remoteBuilderOrders = {};
  var key = homeRoom + '->' + targetRoom;

  var existing = Memory.remoteBuilderOrders[key];
  if (existing) {
    existing.count = parseInt(count, 10);
    existing.updatedAt = Game.time;
    return "[RemoteBuilder] Updated order " + key + " to count=" + existing.count;
  } else {
    Memory.remoteBuilderOrders[key] = {
      homeRoom: homeRoom,
      targetRoom: targetRoom,
      count: parseInt(count, 10),
      createdAt: Game.time,
      updatedAt: Game.time
    };
    return "[RemoteBuilder] Order created: " + key + " with count=" + count;
  }
};

global.cancelRemoteBuilder = function(homeRoom, targetRoom) {
  if (!homeRoom || !targetRoom) {
    return "[RemoteBuilder] Invalid command. Use: cancelRemoteBuilder('homeRoom', 'targetRoom')";
  }
  if (!Memory.remoteBuilderOrders) return "[RemoteBuilder] No remote builder orders exist.";

  var key = homeRoom + '->' + targetRoom;
  if (!Memory.remoteBuilderOrders[key]) {
    return "[RemoteBuilder] No order found for " + key + ".";
  }

  delete Memory.remoteBuilderOrders[key];
  return "[RemoteBuilder] Cancelled order for " + key + ". Existing creeps will not be replaced.";
};

global.listRemoteBuilders = function() {
  if (!Memory.remoteBuilderOrders || Object.keys(Memory.remoteBuilderOrders).length === 0) {
    return "[RemoteBuilder] No active remote builder orders.";
  }

  var lines = [];
  for (var key in Memory.remoteBuilderOrders) {
    var o = Memory.remoteBuilderOrders[key];
    var living = _.filter(Game.creeps, function(c) {
      return c.memory &&
             c.memory.role === 'remoteBuilder' &&
             c.memory.homeRoom === o.homeRoom &&
             c.memory.targetRoom === o.targetRoom;
    }).length;

    lines.push(o.homeRoom + " -> " + o.targetRoom +
               " | desired=" + o.count +
               " | living=" + living +
               " | key=" + key);
  }
  return lines.join(" || ");
};


    global.orderMineralCollect = function (roomName) {
      var missing = ensureDeps([
        { name: 'getRoomState', value: getRoomState },
        { name: 'getCreepBody', value: getCreepBody },
        { name: 'bodyCost', value: bodyCost }
      ]);
      if (missing) return "[MineralCollector] Missing dependency: " + missing;

      if (!Game.rooms[roomName] || !Game.rooms[roomName].controller || !Game.rooms[roomName].controller.my) {
        return "[MineralCollector] Invalid room: " + roomName;
      }
      var rs = getRoomState.get(roomName);
      var freeSpawn = null;
      if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
        for (var i = 0; i < rs.structuresByType[STRUCTURE_SPAWN].length; i++) {
          var sp = rs.structuresByType[STRUCTURE_SPAWN][i];
          if (sp.my && !sp.spawning) { freeSpawn = sp; break; }
        }
      } else {
        freeSpawn = Game.rooms[roomName].find(FIND_MY_SPAWNS, { filter: function(s){ return !s.spawning; } })[0];
      }
      if (!freeSpawn) return "[MineralCollector] No free spawn in " + roomName;

      var body = getCreepBody('supplier', freeSpawn.room.energyAvailable);
      var cost = bodyCost(body);
      if (cost > freeSpawn.room.energyAvailable) {
        return "[MineralCollector] Not enough energy (need " + cost + ")";
      }

      var name = "MC_" + roomName + "_" + Game.time;
      freeSpawn.spawnCreep(body, name, { memory: { role: 'mineralCollector', homeRoom: roomName } });
      return "[MineralCollector] Spawning " + name;
    };
  }
};