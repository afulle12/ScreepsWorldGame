// LLM: Read docs/codex.js before reviewing or changing this file.
// roleScout.js
// Role dispatch: memory.role === 'scout' -> roleScout.run(creep).
// Example: require('roleScout').run(creep);
// Example: require('roleScout').run(creep);
//   orderExplore('W1N8')                     Spawn a scout, explore that room.
//   orderCheckRoom('E2N47', 'E9N44')         Mission: check if a path is clear (from, to).
//   orderAutonomousScout()                   Fire-and-forget autonomous explorer.
//   orderPathfinder('W1N8', 'E5N8')          Find a safe path (from, to), retrying until found.
//   orderAutonomousInterShardScout()         Autonomously find + traverse inter-shard portals.
//   orderAutonomousInterShardScout('shard2') Same, preferring a specific shard.
//   listInterShardPortals()                  List all discovered inter-shard portals.
//   All are require('roleScout').<fn>(...).
const DETAILED_LOGGING = true;
const spawnManager = require("spawnManager");
const iff = require("iff");
const getRoomState = require("getRoomState");
const log = o => {
  if (DETAILED_LOGGING) {
    console.log(o);
  }
};
function getScoutState(o) {
  if (!Memory.scoutState) Memory.scoutState = {};
  const e = Memory.scoutState[o.name] || (Memory.scoutState[o.name] = {});
  const t = [ "route", "routeTarget", "localBlacklist", "pathTaken", "visitedRooms" ];
  for (let n = 0; n < t.length; n++) {
    const r = t[n];
    if (o.memory[r] !== undefined && e[r] === undefined) {
      e[r] = o.memory[r];
    }
    if (o.memory[r] !== undefined) delete o.memory[r];
  }
  return e;
}

function rememberPathRoom(o, e, t) {
  if (!e.pathTaken) e.pathTaken = [ t || o.room.name ];
  if (e.pathTaken[e.pathTaken.length - 1] !== o.room.name) {
    e.pathTaken.push(o.room.name);
  }
  return e.pathTaken;
}

const parseRoomName = function(o) {
  const e = o.match(/^([WE])(\d+)([NS])(\d+)$/);
  if (!e) return null;
  return {
    xDir: e[1],
    x: parseInt(e[2], 10),
    yDir: e[3],
    y: parseInt(e[4], 10)
  };
};
const getNearbyHighwayRooms = function(o, e) {
  e = e || 3;
  const t = parseRoomName(o);
  if (!t) return [];
  const n = t.xDir === "W" ? -t.x : t.x;
  const r = t.yDir === "N" ? -t.y : t.y;
  const s = Math.round(n / 10) * 10;
  const a = Math.round(r / 10) * 10;
  const i = [];
  for (let t = -e; t <= e; t++) {
    for (let n = -e; n <= e; n++) {
      const e = s + t * 10;
      const r = a + n * 10;
      const m = e < 0 ? "W" : "E";
      const l = r < 0 ? "N" : "S";
      const c = `${m}${Math.abs(e)}${l}${Math.abs(r)}`;
      const u = Game.map.getRoomLinearDistance(o, c);
      i.push({
        name: c,
        dist: u
      });
    }
  }
  i.sort((o, e) => o.dist - e.dist);
  return [ ...new Map(i.map(o => [ o.name, o ])).values() ].map(o => o.name);
};
const roleScout = {
  //   require('roleScout').orderAutonomousInterShardScout();
  //   require('roleScout').orderAutonomousInterShardScout('shard2');
  orderAutonomousInterShardScout: function(o) {
    let e = null;
    for (const o in Game.rooms) {
      const t = Game.rooms[o];
      if (t.controller && t.controller.my) {
        const o = t.find(FIND_MY_SPAWNS, {
          filter: o => !o.spawning
        });
        if (o.length > 0) {
          e = o[0];
          break;
        }
      }
    }
    if (!e) {
      const o = `❌ Error: No available spawn found to launch an inter-shard scout.`;
      console.log(o);
      return o;
    }
    const t = getNearbyHighwayRooms(e.room.name, 3);
    const n = `ISScout_${Game.time % 1e3}`;
    const r = [ MOVE ];
    const s = {
      role: "scout",
      task: "interShardAutonomous",
      phase: "findingPortals",
      homeRoom: e.room.name,
      homeShard: Game.shard ? Game.shard.name : "shard0",
      preferredShard: o || null,
      highwayQueue: t,
      checkedRooms: [],
      portalId: null,
      portalRoom: null
    };
    const a = spawnManager.spawnCustomCreep(e, r, n, s);
    if (a === OK) {
      const t = o ? ` (targeting ${o})` : " (any shard)";
      const r = `✅ Spawning inter-shard scout '${n}' from ${e.room.name}${t}.`;
      console.log(r);
      return r;
    } else {
      const o = `❌ Failed to spawn inter-shard scout. Error code: ${a}`;
      console.log(o);
      return o;
    }
  },
  listInterShardPortals: function() {
    if (!Memory.interShardPortals || Object.keys(Memory.interShardPortals).length === 0) {
      console.log("No inter-shard portals discovered yet.");
      return;
    }
    console.log("=== INTER-SHARD PORTALS ===");
    for (const o in Memory.interShardPortals) {
      const e = Memory.interShardPortals[o];
      console.log(`  ${e.fromRoom} (${e.fromShard}) → ${e.toRoom} on ${e.toShard}  [found tick ${e.foundAt}]`);
    }
  },
  //   findingPortals  — travel through highway queue, scan each room
  //   traversing      — move onto the discovered portal tile
  runInterShardAutonomousTask: function(o) {
    const e = o.memory;
    if (e.phase === "traversing") {
      const t = Game.shard ? Game.shard.name : "shard0";
      if (t !== e.homeShard) {
        log(`✅ Inter-shard scout [${o.name}] confirmed jump to ${t}! Switching to autonomous.`);
        e.task = "autonomous";
        e.phase = null;
        return;
      }
      let n = Game.getObjectById(e.portalId);
      if (!n && o.room.name === e.portalRoom) {
        const t = o.room.find(FIND_STRUCTURES, {
          filter: o => o.structureType === STRUCTURE_PORTAL && o.destination && typeof o.destination === "object" && o.destination.shard === e.targetShard
        });
        if (t.length > 0) {
          n = t[0];
          e.portalId = n.id;
          log(`🌀 Inter-shard scout [${o.name}] re-acquired portal reference in ${o.room.name}.`);
        }
      }
      if (!n) {
        if (o.room.name !== e.portalRoom) {
          log(`🌀 Inter-shard scout [${o.name}] lost portal, heading back to ${e.portalRoom}.`);
          this.travelToRoom(o, e.portalRoom);
        } else {
          log(`⚠️ Inter-shard scout [${o.name}] portal gone from ${e.portalRoom}. Re-scanning highway rooms.`);
          e.phase = "findingPortals";
          e.portalId = null;
          e.portalRoom = null;
          e.targetShard = null;
          e.checkedRooms = (e.checkedRooms || []).filter(e => e !== o.room.name);
        }
        return;
      }
      o.say("🌀 Jump!");
      log(`🌀 Inter-shard scout [${o.name}] stepping onto portal in ${o.room.name} → ${e.targetShard}.`);
      o.moveTo(n, {
        reusePath: 3,
        visualizePathStyle: false
      });
      return;
    }
    if (!e.highwayQueue) e.highwayQueue = [];
    if (!e.checkedRooms) e.checkedRooms = [];
    if (o.room.name !== e.currentHighwayTarget || !e.currentHighwayTarget) {
      while (e.highwayQueue.length > 0 && e.checkedRooms.includes(e.highwayQueue[0])) {
        e.highwayQueue.shift();
      }
      if (e.highwayQueue.length === 0) {
        log(`🔭 Inter-shard scout [${o.name}] exhausted initial highway queue. Expanding search.`);
        const t = getNearbyHighwayRooms(o.room.name, 6);
        e.highwayQueue = t.filter(o => !e.checkedRooms.includes(o));
        if (e.highwayQueue.length === 0) {
          console.log(`❌ Inter-shard scout [${o.name}] could not find any new highway rooms to check. Suiciding.`);
          o.suicide();
          return;
        }
      }
      e.currentHighwayTarget = e.highwayQueue[0];
      log(`🗺️ Inter-shard scout [${o.name}] heading to highway room ${e.currentHighwayTarget}.`);
    }
    if (o.room.name !== e.currentHighwayTarget) {
      const t = this.travelToRoom(o, e.currentHighwayTarget);
      if (t === ERR_NO_PATH) {
        log(`⚠️ Inter-shard scout [${o.name}] can't reach ${e.currentHighwayTarget}. Skipping.`);
        e.checkedRooms.push(e.currentHighwayTarget);
        e.highwayQueue.shift();
        e.currentHighwayTarget = null;
      }
      return;
    }
    if (!e.checkedRooms.includes(o.room.name)) {
      e.checkedRooms.push(o.room.name);
    }
    e.highwayQueue = e.highwayQueue.filter(e => e !== o.room.name);
    const t = o.room.find(FIND_STRUCTURES, {
      filter: o => o.structureType === STRUCTURE_PORTAL
    });
    const n = t.filter(o => o.destination && typeof o.destination === "object" && o.destination.shard);
    if (n.length === 0) {
      log(`🔭 Inter-shard scout [${o.name}] found no inter-shard portals in ${o.room.name}.`);
      e.currentHighwayTarget = null;
      return;
    }
    let r = null;
    if (e.preferredShard) {
      r = n.find(o => o.destination.shard === e.preferredShard);
      if (!r) {
        log(`ℹ️ Inter-shard scout [${o.name}] found portals in ${o.room.name} but none go to ${e.preferredShard}. Continuing search.`);
        e.currentHighwayTarget = null;
        return;
      }
    } else {
      r = n[0];
    }
    if (!Memory.interShardPortals) Memory.interShardPortals = {};
    const s = `${o.room.name}_${r.destination.shard}`;
    Memory.interShardPortals[s] = {
      fromShard: e.homeShard,
      fromRoom: o.room.name,
      toShard: r.destination.shard,
      toRoom: r.destination.room || "?",
      portalPos: r.pos,
      foundAt: Game.time
    };
    console.log(`🌀 Inter-shard scout [${o.name}] found portal in ${o.room.name} → ${r.destination.shard} (${r.destination.room || "unknown room"}). Preparing to jump!`);
    Game.notify(`🌀 Inter-shard portal discovered in ${o.room.name} → ${r.destination.shard}`, 60);
    e.portalId = r.id;
    e.portalRoom = o.room.name;
    e.targetShard = r.destination.shard;
    e.phase = "traversing";
  },
  orderExplore: function(o) {
    if (!o) return "Error: destinationRoomName is required.";
    let e = null;
    let t = Infinity;
    for (const n in Game.rooms) {
      const r = Game.rooms[n];
      if (r.controller && r.controller.my) {
        const s = r.find(FIND_MY_SPAWNS, {
          filter: o => !o.spawning
        });
        if (s.length > 0) {
          const s = Game.map.getRoomLinearDistance(n, o);
          if (s < t) {
            t = s;
            e = r;
          }
        }
      }
    }
    if (!e) {
      const e = `❌ Error: No available spawn found to start exploration mission to ${o}.`;
      console.log(e);
      return e;
    }
    const n = e.find(FIND_MY_SPAWNS, {
      filter: o => !o.spawning
    })[0];
    const r = `Scout_${o}_${Game.time % 1e3}`;
    const s = [ MOVE ];
    const a = {
      role: "scout",
      targetRoom: o
    };
    const i = spawnManager.spawnCustomCreep(n, s, r, a);
    if (i === OK) {
      const t = `✅ Spawning scout '${r}' from ${e.name} to explore ${o}.`;
      console.log(t);
      return t;
    } else {
      const o = `❌ Failed to spawn scout from ${e.name}. Error code: ${i}`;
      console.log(o);
      return o;
    }
  },
  orderCheckRoom: function(o, e) {
    if (!o || !e) return "Error: Both spawnRoomName and destinationRoomName are required.";
    const t = Game.rooms[o];
    if (!t) return `Error: No vision in spawn room ${o}.`;
    const n = t.find(FIND_MY_SPAWNS, {
      filter: o => !o.spawning
    });
    if (!n.length) return `Error: No available spawn in room ${o}.`;
    const r = n[0];
    const s = `VisCheck_${e}_${Game.time % 1e3}`;
    const a = [ MOVE ];
    const i = {
      role: "scout",
      task: "checkRoom",
      destinationRoom: e,
      spawnRoom: o
    };
    const m = spawnManager.spawnCustomCreep(r, a, s, i);
    if (m === OK) {
      const t = `✅ Spawning scout '${s}' from ${o} to check room ${e}.`;
      console.log(t);
      return t;
    } else {
      const o = `❌ Failed to spawn scout. Error code: ${m}`;
      console.log(o);
      return o;
    }
  },
  orderAutonomousScout: function() {
    let o = null;
    for (const e in Game.rooms) {
      const t = Game.rooms[e];
      if (t.controller && t.controller.my) {
        const e = t.find(FIND_MY_SPAWNS, {
          filter: o => !o.spawning
        });
        if (e.length > 0) {
          o = e[0];
          break;
        }
      }
    }
    if (!o) {
      const o = `❌ Error: No available spawn found to launch an autonomous scout.`;
      console.log(o);
      return o;
    }
    const e = `AutoScout_${Game.time % 1e3}`;
    const t = [ MOVE ];
    const n = {
      role: "scout",
      task: "autonomous",
      homeRoom: o.room.name
    };
    const r = spawnManager.spawnCustomCreep(o, t, e, n);
    if (r === OK) {
      const t = `✅ Spawning autonomous scout '${e}' from ${o.room.name}.`;
      console.log(t);
      return t;
    } else {
      const e = `❌ Failed to spawn autonomous scout from ${o.room.name}. Error code: ${r}`;
      console.log(e);
      return e;
    }
  },
  orderPathfinder: function(o, e) {
    if (!o || !e) return "Error: Both originRoomName and destinationRoomName are required.";
    const t = `path_${o}_${e}`;
    if (!Memory.pathfindingMissions) Memory.pathfindingMissions = {};
    const n = Memory.pathfindingMissions[t];
    if (n && n.status === "active") return `ℹ️ Mission [${t}] is already active.`;
    if (n && n.status === "success") return `✅ Mission [${t}] has already succeeded. Path: ${n.foundPath.join(" → ")}`;
    Memory.pathfindingMissions[t] = {
      origin: o,
      destination: e,
      status: "initializing",
      attempts: 0,
      blacklistedRooms: {},
      activeScout: null,
      foundPath: null,
      startTime: Game.time
    };
    console.log(`🚀 Initializing new pathfinding mission [${t}] from ${o} to ${e}.`);
    return this.spawnPathfinderScout(t);
  },
  spawnPathfinderScout: function(o) {
    if (!Memory.pathfindingMissions || !Memory.pathfindingMissions[o]) {
      return `Error: Cannot find mission data for ${o}.`;
    }
    const e = Memory.pathfindingMissions[o];
    if (e.blacklistedRooms[e.origin]) {
      e.status = "failed";
      e.failureReason = `Origin room ${e.origin} is impassable or dangerous.`;
      const t = `❌ Pathfinding Mission [${o}] Failed: ${e.failureReason}`;
      console.log(t);
      Game.notify(t, 60);
      return t;
    }
    const t = Game.map.findRoute(e.origin, e.destination, {
      routeCallback: o => {
        if (e.blacklistedRooms[o]) return Infinity;
        return 1;
      }
    });
    if (t === ERR_NO_PATH || t.length === 0) {
      e.status = "failed";
      e.failureReason = `No possible global path exists from ${e.origin} to ${e.destination} with the current blacklist.`;
      const t = `❌ Pathfinding Mission [${o}] Failed: ${e.failureReason}`;
      console.log(t);
      Game.notify(t, 60);
      return t;
    }
    const n = Game.rooms[e.origin];
    if (!n || !n.controller || !n.controller.my) {
      e.status = "failed";
      e.failureReason = `No vision or control in origin room ${e.origin}.`;
      console.log(`❌ Mission [${o}] Failed: ${e.failureReason}`);
      Game.notify(`❌ Mission [${o}] Failed: ${e.failureReason}`);
      return e.failureReason;
    }
    const r = n.find(FIND_MY_SPAWNS, {
      filter: o => !o.spawning
    });
    if (!r.length) {
      return `Warning: No available spawn in room ${e.origin} to continue mission [${o}].`;
    }
    const s = r[0];
    e.attempts += 1;
    const a = `Pathfinder_${o.replace(/_/g, "")}_${Game.time % 1e3}`;
    const i = [ MOVE ];
    const m = {
      role: "scout",
      task: "pathfinder",
      missionId: o,
      originRoom: e.origin,
      destinationRoom: e.destination
    };
    const l = spawnManager.spawnCustomCreep(s, i, a, m);
    if (l === OK) {
      e.status = "active";
      e.activeScout = a;
      const t = `✅ Spawning pathfinder scout '${a}' (Attempt #${e.attempts}) for mission [${o}].`;
      console.log(t);
      return t;
    } else {
      e.attempts -= 1;
      return `❌ Failed to spawn pathfinder scout for mission [${o}]. Error code: ${l}`;
    }
  },
  handleCreepDeath: function(o, e) {
    if (!e || e.role !== "scout") return;
    if (e.task === "pathfinder") {
      const t = e.missionId;
      const n = Memory.pathfindingMissions ? Memory.pathfindingMissions[t] : undefined;
      if (n && n.status === "active" && n.activeScout === o) {
        const r = e.lastAttackedIn || e.lastRoom;
        if (r) {
          this.markRoomAsDangerous(r, "pathfinder_death", true);
          n.blacklistedRooms[r] = true;
          console.log(`💀 Pathfinder [${o}] died in ${r}. Room blacklisted globally and for mission [${t}].`);
          this.spawnPathfinderScout(t);
        } else {
          n.status = "failed";
          n.failureReason = `Scout [${o}] died in an unknown location.`;
          const e = `❌ Pathfinding Mission [${t}] Failed: ${n.failureReason}`;
          console.log(e);
          Game.notify(e, 60);
        }
      }
    } else if (e.task === "checkRoom" && !e.notificationSent) {
      const t = e.lastAttackedIn || e.lastRoom;
      if (t) {
        this.markRoomAsDangerous(t, "scout_death", true);
        console.log(`💀 Scout [${o}] died in ${t}. Room marked as dangerous.`);
      }
      const n = `❌ Mission Failed: Scout [${o}] died before reaching ${e.destinationRoom}.`;
      Game.notify(n, 0);
      console.log(n);
    }
    if (Memory.scoutState) delete Memory.scoutState[o];
  },
  handleDeadCreeps: function() {
    if (!Memory.scoutState) return;
    for (const o in Memory.scoutState) {
      if (!Game.creeps[o]) delete Memory.scoutState[o];
    }
  },
  run: function(o) {
    if (o.spawning) return;
    const e = getScoutState(o);
    if (o.memory.lastRoom !== o.room.name) {
      o.memory.previousRoom = o.memory.lastRoom;
      o.memory.lastRoom = o.room.name;
      if (!o.memory.backtracking) {
        delete e.localBlacklist;
      }
      if (o.memory.task === "pathfinder") {
        log(`Pathfinder [${o.name}] mission [${o.memory.missionId}] entered new room: ${o.room.name}`);
      }
    }
    if (this.checkForDanger(o)) {
      return;
    }
    if (o.memory.task === "interShardAutonomous") {
      this.runInterShardAutonomousTask(o);
    } else if (o.memory.task === "pathfinder") {
      this.runPathfinderTask(o);
    } else if (o.memory.task === "checkRoom") {
      this.runCheckRoomTask(o);
    } else {
      this.runAutonomousTask(o);
    }
  },
  travelToRoom: function(o, e) {
    const t = getScoutState(o);
    if (!t.route || t.routeTarget !== e) {
      delete t.route;
      o.memory.backtracking = false;
      log(`🗺️ Scout [${o.name}] calculating new route from ${o.room.name} to ${e}.`);
      const n = o.memory.task === "pathfinder" && Memory.pathfindingMissions && Memory.pathfindingMissions[o.memory.missionId] ? Memory.pathfindingMissions[o.memory.missionId].blacklistedRooms : {};
      if (Object.keys(n).length > 0) log(`   - Mission blacklist: [${Object.keys(n).join(", ")}]`);
      if (t.localBlacklist && Object.keys(t.localBlacklist).length > 0) log(`   - Temp local blacklist: [${Object.keys(t.localBlacklist).join(", ")}]`);
      const r = Game.map.findRoute(o.room.name, e, {
        routeCallback: e => {
          if (o.memory.task === "pathfinder") {
            if (n[e]) return Infinity;
            if (t.localBlacklist && t.localBlacklist[e]) return Infinity;
          } else {
            if (this.isRoomDangerous(e)) return Infinity;
          }
          return 1;
        }
      });
      if (r === ERR_NO_PATH || r.length === 0) {
        log(`❌ Scout [${o.name}] found NO GLOBAL PATH to ${e}. All exits may be blocked or blacklisted.`);
        return ERR_NO_PATH;
      }
      log(`   ✔️ Path found for [${o.name}]: ${JSON.stringify(r.map(o => o.room))}`);
      t.route = r;
      t.routeTarget = e;
    }
    const n = t.route;
    if (n && n.length > 0) {
      if (n[0].room === o.room.name) {
        n.shift();
      }
      if (n.length > 0) {
        const e = o.pos.findClosestByPath(n[0].exit);
        if (e) {
          log(`   🏃 [${o.name}] moving towards exit to ${n[0].room}.`);
          o.moveTo(e, {
            reusePath: 5,
            ignoreCreeps: true,
            visualizePathStyle: false
          });
          return OK;
        } else {
          const e = n[0].room;
          log(`   ⚠️ [${o.name}] could not find a LOCAL path to the exit for room ${e}. Adding to temporary blacklist and will recalculate route.`);
          if (!t.localBlacklist) {
            t.localBlacklist = {};
          }
          t.localBlacklist[e] = true;
          o.memory.backtracking = true;
          delete t.route;
          return OK;
        }
      }
    }
    delete t.route;
    return OK;
  },
  runPathfinderTask: function(o) {
    const e = o.memory.missionId;
    const t = Memory.pathfindingMissions ? Memory.pathfindingMissions[e] : undefined;
    if (!t || t.status !== "active") {
      o.say("✅ Over");
      o.suicide();
      return;
    }
    const n = getScoutState(o);
    const r = o.memory.destinationRoom;
    if (o.room.name === r) {
      const r = rememberPathRoom(o, n, o.memory.originRoom);
      const s = r.join(" → ");
      t.status = "success";
      t.foundPath = r;
      t.finishTime = Game.time;
      const a = `✅ Path Found! Mission [${e}] succeeded.\nRoute: ${s}`;
      console.log(a);
      Game.notify(a, 60);
      o.say("✅ Path!");
      o.suicide();
      return;
    }
    rememberPathRoom(o, n, o.memory.originRoom);
    const s = this.travelToRoom(o, r);
    if (s === ERR_NO_PATH) {
      log(`Pathfinder [${o.name}] is stuck in ${o.room.name}. Terminating scout to trigger retry.`);
      o.say("🚫 Stuck");
      o.suicide();
    }
  },
  runCheckRoomTask: function(o) {
    const e = getScoutState(o);
    const t = o.memory.destinationRoom;
    if (o.room.name === t) {
      if (!o.memory.notificationSent) {
        const n = rememberPathRoom(o, e, o.memory.spawnRoom);
        const r = n.join(" → ");
        const s = `✅ Mission Complete: Scout [${o.name}] reached ${t}.\nPath: ${r}`;
        Game.notify(s, 0);
        console.log(s);
        o.memory.notificationSent = true;
        o.say("✅ Done!");
      }
      this.idle(o);
    } else {
      rememberPathRoom(o, e, o.memory.spawnRoom);
      const n = this.travelToRoom(o, t);
      if (n === ERR_NO_PATH) {
        if (!o.memory.notificationSent) {
          const e = `❌ Mission Failed: Scout [${o.name}] could not find a safe path to ${t}.`;
          Game.notify(e, 0);
          console.log(e);
          o.memory.notificationSent = true;
        }
        o.say("🚫 Path");
        o.suicide();
      }
    }
  },
  runAutonomousTask: function(o) {
    const e = getScoutState(o);
    if (o.memory.fleeing) {
      if (o.room.name === o.memory.previousRoom || !o.memory.previousRoom) {
        log(`✅ Scout ${o.name} successfully fled. Looking for new target.`);
        delete o.memory.fleeing;
        this.assignTargetRoom(o);
      } else {
        o.say("😱 RUN!");
        o.moveTo(new RoomPosition(25, 25, o.memory.previousRoom));
        return;
      }
    }
    if (!Memory.dangerousRooms) Memory.dangerousRooms = {};
    if (!o.memory.targetRoom) this.assignTargetRoom(o);
    if (o.memory.lastRoom !== o.room.name) {
      o.memory.roomScanned = false;
      delete e.route;
      if (!e.visitedRooms) e.visitedRooms = {};
      e.visitedRooms[o.room.name] = Game.time;
      log(`🔍 Scout ${o.name} entered room ${o.room.name} (target: ${o.memory.targetRoom})`);
    }
    if (o.room.name !== o.memory.targetRoom) {
      this.travelToRoom(o, o.memory.targetRoom);
    } else {
      log(`🎯 Scout ${o.name} arrived at target room ${o.room.name}`);
      this.gatherIntelligence(o);
      log(`⏱️ Scout ${o.name} finished scanning ${o.room.name}, looking for new target`);
      this.assignTargetRoom(o);
    }
  },
  idle: function(o) {
    const e = new RoomPosition(48, 48, o.room.name);
    if (!o.pos.isEqualTo(e)) o.moveTo(e);
  },
  checkForDanger: function(o) {
    const e = o.room;
    if (e.controller && e.controller.owner && iff.isFriendlyUsername(e.controller.owner.username)) return false;
    if (o.hits < o.hitsMax && (!o.memory.lastHits || o.memory.lastHits > o.hits)) {
      o.memory.lastAttackedIn = o.room.name;
      if (o.memory.task !== "pathfinder" && o.memory.task !== "interShardAutonomous") {
        this.markRoomAsDangerous(o.room.name, "hostile_creeps", false);
        log(`⚔️ DANGER! Scout ${o.name} under attack in ${o.room.name}!`);
        o.memory.fleeing = true;
        return true;
      } else {
        log(`⚔️ Scout ${o.name} taking damage in ${o.room.name} but continuing mission`);
      }
    }
    o.memory.lastHits = o.hits;
    const t = e.find(FIND_HOSTILE_STRUCTURES, {
      filter: o => o.structureType === STRUCTURE_TOWER
    });
    if (t.length > 0) {
      if (o.memory.task !== "pathfinder" && o.memory.task !== "interShardAutonomous") {
        this.markRoomAsDangerous(o.room.name, "hostile_towers", true);
        o.memory.lastAttackedIn = o.room.name;
        log(`🏰 DANGER! Scout ${o.name} detected hostile towers in ${o.room.name}!`);
        o.memory.fleeing = true;
        return true;
      } else {
        log(`🏰 Scout ${o.name} detected hostile towers in ${o.room.name} but continuing mission`);
      }
    }
    return false;
  },
  markRoomAsDangerous: function(o, e, t) {
    if (!Memory.dangerousRooms) Memory.dangerousRooms = {};
    const n = t ? 999999999 : 5e4;
    Memory.dangerousRooms[o] = {
      markedAt: Game.time,
      reason: e,
      cooldownUntil: Game.time + n,
      permanent: t
    };
    const r = {
      hostile_creeps: "hostile creeps",
      hostile_towers: "hostile towers",
      pathfinder_death: "pathfinder scout death",
      scout_death: "scout death"
    }[e] || e;
    if (Memory.pathfindingMissions) {
      for (const e in Memory.pathfindingMissions) {
        const t = Memory.pathfindingMissions[e];
        if (t.status === "active") {
          t.blacklistedRooms[o] = true;
          console.log(`Added dangerous room ${o} to mission ${e} blacklist`);
        }
      }
    }
    if (t) console.log(`🚫 PERMANENTLY AVOIDING room ${o} due to ${r}`); else console.log(`⏰ Avoiding room ${o} for ${n} ticks due to ${r}`);
  },
  isRoomDangerous: function(o) {
    if (!Memory.dangerousRooms || !Memory.dangerousRooms[o]) return false;
    const e = Memory.dangerousRooms[o];
    if (e.permanent) return true;
    if (Game.time > e.cooldownUntil) {
      delete Memory.dangerousRooms[o];
      console.log(`✅ Room ${o} is no longer marked as dangerous.`);
      return false;
    }
    return true;
  },
  assignTargetRoom: function(o) {
    const e = getScoutState(o);
    delete e.route;
    const t = Game.map.describeExits(o.room.name);
    if (!t) return;
    if (!e.visitedRooms) e.visitedRooms = {};
    const n = [];
    for (const o in t) {
      const r = t[o];
      if (Game.rooms[r] && Game.rooms[r].controller && Game.rooms[r].controller.my) continue;
      const s = e.visitedRooms[r] && Game.time - e.visitedRooms[r] < 500;
      const a = this.isRoomDangerous(r);
      if (!s && !a) n.push(r);
    }
    if (n.length > 0) {
      const e = n[Math.floor(Math.random() * n.length)];
      o.memory.targetRoom = e;
      o.say("🚪" + e);
      log(`🆕 Scout ${o.name} assigned NEW target: ${e}`);
      return;
    }
    let r = Game.time;
    let s = null;
    for (const o in t) {
      const n = t[o];
      if (!this.isRoomDangerous(n)) {
        const o = e.visitedRooms[n] || 0;
        if (o < r) {
          r = o;
          s = n;
        }
      }
    }
    if (s) {
      o.memory.targetRoom = s;
      o.say("🔄" + s);
      log(`🔄 Scout ${o.name} assigned OLD target: ${s}`);
    } else {
      o.memory.targetRoom = o.room.name;
      o.say("🏠 SAFE");
      console.log(`⚠️ Scout ${o.name} has no safe rooms to explore, staying put.`);
    }
  },
  gatherIntelligence: function(o) {
    if (o.memory.roomScanned) return;
    const e = o.room;
    const t = e.name;
    const n = getRoomState.get(t);
    const r = n && n.hostiles || e.find(FIND_HOSTILE_CREEPS);
    const s = n && n.sources || e.find(FIND_SOURCES);
    const a = n && n.minerals || e.find(FIND_MINERALS);
    let i = e.controller && e.controller.owner ? ` (owned by ${e.controller.owner.username})` : "";
    log(`📊 Scout ${o.name} scanned ${t}: ${s.length} sources, ${a.length} minerals, ${r.length} hostiles${i}`);
    o.memory.roomScanned = true;
  }
};
module.exports = roleScout;
