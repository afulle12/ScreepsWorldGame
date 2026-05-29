// roleRepairBot.js
// Spawned when 3+ roads are below 50% health in a room, OR when any container
// is below CONTAINER_TRIGGER_HITS (200k).
// On first tick: computes a greedy nearest-neighbor route through up to 25
// damaged roads and containers and stores the ordered ID list in memory.
// Works through the queue in order, repairs each structure to its done threshold
// (ROAD_DONE_THRESHOLD for roads, CONTAINER_DONE_HITS for containers),
// then advances. When the queue is empty, attempts to rebuild before giving up.
// On confirmed empty rebuild: deposits remaining energy into storage (if any)
// and suicides, writing a cooldown to Memory so the spawn manager doesn't
// immediately re-trigger.
// Rampart repair is disabled — handled by a dedicated role.

const getRoomState = require('getRoomState');

const ROAD_DONE_THRESHOLD    = 0.99;    // consider a road done at 99% — avoids chasing last few hits
const CONTAINER_TRIGGER_HITS = 200000;  // include a container in the queue below this
const CONTAINER_DONE_HITS    = 244000;  // consider a container done once it reaches this
const MAX_ROADS               = 25;
const SPAWN_COOLDOWN          = 50;     // ticks to wait after suicide before spawning a replacement
const MOVE_OPTS_CLOSE         = { reusePath: 15, range: 1};
const MOVE_OPTS_REPAIR        = { reusePath: 15, range: 3};


// ─── Route planning ───────────────────────────────────────────────────────────

/**
 * Greedy nearest-neighbor tour through all damaged roads and containers,
 * starting from the creep's current position.
 * Returns an ordered array of structure IDs (≤ MAX_ROADS).
 * Runs once on spawn — O(N²) getRangeTo calls are acceptable at N ≤ 25.
 */
function buildRepairQueue(creep, rs) {
  if (!rs || !rs.structuresByType) return [];

  var roads      = rs.structuresByType[STRUCTURE_ROAD]      || [];
  var containers = rs.structuresByType[STRUCTURE_CONTAINER] || [];
  var damaged = [];

  for (var i = 0; i < roads.length; i++) {
    var road = roads[i];
    if (!road || typeof road.hits !== 'number' || typeof road.hitsMax !== 'number') continue;
    if (road.hitsMax === 0) continue;
    if (road.hits < road.hitsMax * ROAD_DONE_THRESHOLD) damaged.push(road);
  }

  for (var ci = 0; ci < containers.length; ci++) {
    var cont = containers[ci];
    if (!cont || typeof cont.hits !== 'number') continue;
    if (cont.hits < CONTAINER_TRIGGER_HITS) damaged.push(cont);
  }

  if (damaged.length === 0) return [];

  var remaining = damaged.slice();
  var route     = [];
  var cur       = creep.pos; // updated to each picked structure's pos as we build the tour

  while (route.length < MAX_ROADS && remaining.length > 0) {
    var bestIdx  = 0;
    var bestDist = cur.getRangeTo(remaining[0].pos);

    for (var j = 1; j < remaining.length; j++) {
      var d = cur.getRangeTo(remaining[j].pos);
      if (d < bestDist) { bestDist = d; bestIdx = j; }
    }

    var picked = remaining.splice(bestIdx, 1)[0];
    route.push(picked.id);
    cur = picked.pos;
  }

  return route; // plain string IDs — safe to store in Memory
}

// ─── Energy helpers ───────────────────────────────────────────────────────────

function getEnergy(creep, rs) {
  var storage = rs ? rs.storage : null;
  if (storage && storage.store && (storage.store[RESOURCE_ENERGY] || 0) > 0) {
    if (creep.pos.isNearTo(storage)) {
      creep.withdraw(storage, RESOURCE_ENERGY);
    } else {
      creep.moveTo(storage, MOVE_OPTS_CLOSE);
    }
    return true;
  }

  var containers = (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_CONTAINER]) || [];
  var best = null;
  var bestAmt = 0;

  for (var i = 0; i < containers.length; i++) {
    var c = containers[i];
    if (!c || !c.store) continue;
    var amt = c.store[RESOURCE_ENERGY] || 0;
    if (amt > bestAmt) { bestAmt = amt; best = c; }
  }

  if (best) {
    if (creep.pos.isNearTo(best)) {
      creep.withdraw(best, RESOURCE_ENERGY);
    } else {
      creep.moveTo(best, MOVE_OPTS_CLOSE);
    }
    return true;
  }

  return false;
}

// ─── End-of-life ──────────────────────────────────────────────────────────────

/**
 * Deposits any remaining energy into storage, then suicides.
 * Writes a spawn cooldown to Memory before dying so the spawn manager doesn't
 * immediately re-trigger on the same tick.
 * If no storage or no energy to deposit, suicides immediately.
 * Uses a one-tick deferred suicide so the transfer isn't wasted.
 */
function depositAndSuicide(creep, rs) {
  if (creep.store[RESOURCE_ENERGY] > 0) {
    var storage = rs ? rs.storage : null;
    if (storage) {
      if (creep.pos.isNearTo(storage)) {
        creep.transfer(storage, RESOURCE_ENERGY);
        creep.memory.pendingSuicide = true; // suicide next tick after transfer lands
      } else {
        creep.moveTo(storage, MOVE_OPTS_CLOSE);
      }
      return;
    }
  }
  // Write cooldown before dying so spawn manager sees it this tick.
  Memory['repairBotCooldown_' + creep.room.name] = Game.time + SPAWN_COOLDOWN;
  creep.suicide();
}

// ─── Main loop ────────────────────────────────────────────────────────────────

function run(creep) {
  // CPU throttle — pause road repair when average CPU is too high
  if (Memory.cpuStats && Memory.cpuStats.average > 19) {
    creep.say('💤');
    return;
  }

  var roomName = creep.room && creep.room.name ? creep.room.name : null;
  if (!roomName) return;

  var rs = getRoomState.get(roomName);
  if (!rs) return;

  // ── Edge guard ───────────────────────────────────────────────────────────
  // If the creep is on a room exit tile, push it inward immediately.
  // Uses reusePath:0 so it always gets a fresh inward path.
  var p = creep.pos;
  if (p.x === 0 || p.x === 49 || p.y === 0 || p.y === 49) {
    creep.moveTo(25, 25, { reusePath: 0, ignoreCreeps: true });
    return;
  }

  // Deferred suicide — transfer was issued last tick, now safe to die.
  if (creep.memory.pendingSuicide) {
    Memory['repairBotCooldown_' + roomName] = Game.time + SPAWN_COOLDOWN;
    creep.suicide();
    return;
  }

  // ── Build queue exactly once, on first tick ──────────────────────────────
  if (!creep.memory.repairQueue) {
    creep.memory.repairQueue = buildRepairQueue(creep, rs);
    if (creep.memory.repairQueue.length === 0) {
      depositAndSuicide(creep, rs);
      return;
    }
    console.log('[RepairBot] ' + creep.name + ' queued ' +
      creep.memory.repairQueue.length + ' structures in ' + roomName);
  }

  // ── Queue exhausted → try to rebuild before giving up ────────────────────
  if (creep.memory.repairQueue.length === 0) {
    var rebuilt = buildRepairQueue(creep, rs);
    if (rebuilt.length > 0) {
      creep.memory.repairQueue = rebuilt;
      console.log('[RepairBot] ' + creep.name + ' rebuilt queue with ' +
        rebuilt.length + ' structures in ' + roomName);
      return; // pick up work next tick
    }
    // Nothing left to do — deposit and die.
    depositAndSuicide(creep, rs);
    return;
  }

  // ── Energy state toggle ──────────────────────────────────────────────────
  if (!creep.memory.working && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
    creep.memory.working = true;
  }
  if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) {
    creep.memory.working = false;
  }

  // ── Refuel ───────────────────────────────────────────────────────────────
  if (!creep.memory.working) {
    getEnergy(creep, rs);
    return;
  }

  // ── Repair current head of queue ─────────────────────────────────────────
  var targetId = creep.memory.repairQueue[0];
  var target   = Game.getObjectById(targetId);

  // Determine the done threshold for this structure type.
  var doneHits = (target && target.structureType === STRUCTURE_CONTAINER)
    ? CONTAINER_DONE_HITS
    : (target ? target.hitsMax * ROAD_DONE_THRESHOLD : 0);

  // Advance if target is gone or sufficiently repaired.
  if (!target || target.hits >= doneHits) {
    creep.memory.repairQueue.shift();
    return; // pick next target next tick
  }

  if (creep.pos.inRangeTo(target, 3)) {
    var res = creep.repair(target);
    if (res === ERR_NOT_ENOUGH_ENERGY) {
      creep.memory.working = false; // flip immediately so next tick refuels
    } else if (res === ERR_INVALID_TARGET || res === ERR_NO_BODYPART) {
      creep.memory.repairQueue.shift();
    }
  } else {
    creep.moveTo(target, MOVE_OPTS_REPAIR);
  }
}

module.exports = { run: run };