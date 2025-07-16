// roleClaimbot.js
// Bot that travels to a target room, avoids edges, then attacks or claims the controller.
// Queue a room claim via: Memory.claimOrders.push({ room: 'E1N1' });

const enableLogging = true;  // Set false to silence logs

module.exports = {
  run: function(creep) {
    // --- INIT & LOGGING ---
    if (enableLogging) {
      console.log(
        `[${creep.name}] start; room=${creep.room.name} target=${creep.memory.targetRoom}`
      );
    }
    const targetRoom = creep.memory.targetRoom;
    if (!targetRoom) {
      if (enableLogging) console.log(`[${creep.name}] no target → suiciding`);
      return creep.suicide();
    }

    // Clear old controller path if we’ve left the target room
    if (creep.room.name !== targetRoom && creep.memory.controllerPath) {
      if (enableLogging) {
        console.log(`[${creep.name}] left ${targetRoom} → clearing controllerPath`);
      }
      delete creep.memory.controllerPath;
    }

    // --- moveAvoidEdges(dest, style) ---
    //  • Inter‐room: creep.moveTo
    //  • In‐room: PathFinder with outer 2‐tile border blocked
    function moveAvoidEdges(dest, style) {
      const pos = dest.pos ? dest.pos : dest;
      if (pos.roomName !== creep.room.name) {
        if (enableLogging) {
          console.log(
            `[${creep.name}] inter‐room moveTo ${pos.roomName}(${pos.x},${pos.y})`
          );
        }
        return creep.moveTo(pos, { visualizePathStyle: style });
      }

      // Build CostMatrix blocking walls & outer border
      const terrain = Game.map.getRoomTerrain(creep.room.name);
      const costs = new PathFinder.CostMatrix();
      for (let y = 0; y < 50; y++) {
        for (let x = 0; x < 50; x++) {
          const t = terrain.get(x, y);
          let c = t === 0 ? 2 : t === 2 ? 10 : 255;
          if (x <= 1 || x >= 48 || y <= 1 || y >= 48) c = 255;
          costs.set(x, y, c);
        }
      }
      creep.room.find(FIND_STRUCTURES).forEach(s => {
        if (s.structureType !== STRUCTURE_ROAD && s.structureType !== STRUCTURE_CONTAINER) {
          costs.set(s.pos.x, s.pos.y, 255);
        }
      });

      const res = PathFinder.search(
        creep.pos,
        { pos, range: 0 },
        {
          maxOps: 2000,
          roomCallback: rn => (rn === creep.room.name ? costs : new PathFinder.CostMatrix())
        }
      );

      if (res.path.length) {
        if (enableLogging) {
          console.log(
            `[${creep.name}] PF→ next (${res.path[0].x},${res.path[0].y})`
          );
        }
        return creep.moveByPath(res.path, { visualizePathStyle: style });
      }

      if (enableLogging) {
        console.log(
          `[${creep.name}] PF failed → fallback moveTo (${pos.x},${pos.y})`
        );
      }
      return creep.moveTo(pos, { visualizePathStyle: style });
    }

    // --- moveToController(style) ---
    // 1) On first tick in room: compute & store full PF path → memory.controllerPath[]
    // 2) Each tick: try stepping one tile along that path
    // 3) If path runs out or errors, fallback to creep.moveTo(controller)
    // 4) Once adjacent, clear path and let attack/claim logic run
    function moveToController(style) {
      const ctrl = creep.room.controller;
      if (!ctrl) {
        if (enableLogging) console.log(`[${creep.name}] no controller here`);
        return;
      }

      // If adjacent, clear stored path
      if (creep.pos.inRangeTo(ctrl, 1)) {
        if (creep.memory.controllerPath) {
          if (enableLogging) {
            console.log(`[${creep.name}] at controller → clearing path`);
          }
          delete creep.memory.controllerPath;
        }
        return;
      }

      // 1) Compute path once on entry
      if (!creep.memory.controllerPath) {
        if (enableLogging) {
          console.log(
            `[${creep.name}] computing path from (${creep.pos.x},${creep.pos.y}) to controller`
          );
        }
        const terrain = Game.map.getRoomTerrain(creep.room.name);
        const costs = new PathFinder.CostMatrix();
        for (let y = 0; y < 50; y++) {
          for (let x = 0; x < 50; x++) {
            const t = terrain.get(x, y);
            let c = t === 0 ? 2 : t === 2 ? 10 : 255;
            if (x <= 1 || x >= 48 || y <= 1 || y >= 48) c = 255;
            costs.set(x, y, c);
          }
        }
        creep.room.find(FIND_STRUCTURES).forEach(s => {
          if (
            s.structureType !== STRUCTURE_ROAD &&
            s.structureType !== STRUCTURE_CONTAINER
          ) {
            costs.set(s.pos.x, s.pos.y, 255);
          }
        });

        const res = PathFinder.search(creep.pos, { pos: ctrl.pos, range: 1 }, {
          maxOps: 2000,
          roomCallback: rn =>
            rn === creep.room.name ? costs : new PathFinder.CostMatrix()
        });
        creep.memory.controllerPath = res.path;
        if (enableLogging) {
          console.log(
            `[${creep.name}] stored controllerPath, length=${res.path.length}`
          );
        }
      }

      // 2) Step one tile
      const path = creep.memory.controllerPath;
      if (Array.isArray(path) && path.length > 0) {
        // drop any step matching current position
        if (path[0].x === creep.pos.x && path[0].y === creep.pos.y) {
          path.shift();
        }
        if (path.length > 0) {
          const nxt = path[0];
          const res = creep.moveTo(
            new RoomPosition(nxt.x, nxt.y, creep.room.name),
            { visualizePathStyle: style, reusePath: 0 }
          );
          if (enableLogging) {
            console.log(
              `[${creep.name}] step→ (${nxt.x},${nxt.y}) result=${res}`
            );
          }
          if (res === OK) {
            path.shift();
            return;
          }
          if (res !== ERR_TIRED) {
            // path broken → clear and fall back
            if (enableLogging) {
              console.log(
                `[${creep.name}] step error (${res}) → clearing path`
              );
            }
            delete creep.memory.controllerPath;
          }
          // if ERR_TIRED, do nothing; next tick we’ll retry
        }
      }

      // 3) Fallback: direct moveTo(controller)
      if (enableLogging) {
        console.log(
          `[${creep.name}] fallback direct moveTo controller`
        );
      }
      creep.moveTo(ctrl, { visualizePathStyle: style, reusePath: 0 });
    }

    // --- MAIN BEHAVIOR ---

    // 1) Travel to target room center
    if (creep.room.name !== targetRoom) {
      if (enableLogging) {
        console.log(`[${creep.name}] traveling to ${targetRoom}`);
      }
      moveAvoidEdges(new RoomPosition(25, 25, targetRoom), {
        stroke: '#ffaa00'
      });
      return;
    }

    // 2) Attack hostile creeps
    const hostileCreep = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
    if (hostileCreep) {
      if (creep.pos.inRangeTo(hostileCreep, 1)) {
        if (enableLogging) {
          console.log(
            `[${creep.name}] attacking hostile creep at ${hostileCreep.pos}`
          );
        }
        creep.attack(hostileCreep);
        creep.say('⚔️Creep');
      } else {
        if (enableLogging) {
          console.log(
            `[${creep.name}] moving to hostile creep at ${hostileCreep.pos}`
          );
        }
        moveAvoidEdges(hostileCreep, { stroke: '#ff0000' });
      }
      return;
    }

    // 3) Attack hostile structures (except controller)
    const hostileStructure = creep.pos.findClosestByRange(FIND_HOSTILE_STRUCTURES, {
      filter: s => s.structureType !== STRUCTURE_CONTROLLER
    });
    if (hostileStructure) {
      if (creep.pos.inRangeTo(hostileStructure, 1)) {
        if (enableLogging) {
          console.log(
            `[${creep.name}] attacking structure at ${hostileStructure.pos}`
          );
        }
        creep.attack(hostileStructure);
        creep.say('⚔️Struct');
      } else {
        if (enableLogging) {
          console.log(
            `[${creep.name}] moving to structure at ${hostileStructure.pos}`
          );
        }
        moveAvoidEdges(hostileStructure, { stroke: '#ff0000' });
      }
      return;
    }

    // 4) Controller logic
    const controller = creep.room.controller;
    if (!controller) {
      if (enableLogging) console.log(`[${creep.name}] no controller here`);
      creep.say('No ctrl!');
      return;
    }

    // 4a) Enemy-owned → attack
    if (!controller.my && controller.owner) {
      if (creep.pos.inRangeTo(controller, 1)) {
        if (enableLogging) {
          console.log(
            `[${creep.name}] attacking enemy controller at ${controller.pos}`
          );
        }
        creep.attackController(controller);
        creep.say('AtkCtrl');
      } else {
        moveToController({ stroke: '#ff00ff' });
      }
      return;
    }

    // 4b) Unowned → claim
    if (!controller.my && !controller.owner) {
      if (creep.pos.inRangeTo(controller, 1)) {
        if (enableLogging) {
          console.log(
            `[${creep.name}] claiming controller at ${controller.pos}`
          );
        }
        const res = creep.claimController(controller);
        creep.say(res === OK ? 'Claimed!' : `Err:${res}`);
        if (enableLogging) {
          console.log(`[${creep.name}] claim result=${res}`);
        }
      } else {
        moveToController({ stroke: '#00ff00' });
      }
      return;
    }

    // 4c) Already ours → done
    if (controller.my) {
      if (enableLogging) console.log(`[${creep.name}] controller mine → suiciding`);
      creep.say('Done!');
      creep.suicide();
    }
  }
};
