// defenseMonitor.js
// ============================================================================
// Defense Monitor
// Detects enemy creep entry and wall/rampart damage using getRoomState +
// room.getEventLog(). Sends Game.notify() alerts and triggers defense
// repair bot spawns when damage threshold is reached AND the damaged
// cluster is the weakest section of wall in the room.
//
// Also detects incoming nukes via FIND_NUKES and sends Game.notify()
// alerts with impact position, source room, ETA, and threatened structures
//
//
// API:
//   defenseMonitor.run()  -> call once per tick from main loop
// ============================================================================

var getRoomState = require('getRoomState');

var DAMAGE_THRESHOLD    = 5;     // damage events before considering spawn
var MAX_DEFENSE_REPAIRS = 2;     // max defense repair creeps per room
var NOTIFY_COOLDOWN     = 200;   // ticks between Game.notify calls per room
var CLUSTER_RANGE       = 1;     // range to consider walls/ramparts contiguous
var EVENT_MEMORY_TTL    = 300;   // ticks before stale damage tracking is cleared

var NUKE_SCAN_INTERVAL  = 100;   // ticks between nuke scans
var NUKE_BLAST_RADIUS   = 2;     // nuke deals damage in a 5x5 area (range 2)
var NUKE_MILESTONE_TICKS = [10000, 1000]; // warn at these remaining-tick thresholds

// ============================================================================
// Initialization
// ============================================================================

function ensureMemory() {
  if (!Memory.defense) Memory.defense = {};
  if (!Memory.defense.knownHostiles)  Memory.defense.knownHostiles  = {};
  if (!Memory.defense.damageEvents)   Memory.defense.damageEvents   = {};
  if (!Memory.defense.repairOrders)   Memory.defense.repairOrders   = {};
  if (!Memory.defense.notifyCooldown) Memory.defense.notifyCooldown = {};
  if (!Memory.defense.clusterCache)   Memory.defense.clusterCache   = {};
  if (!Memory.defense.trackedNukes)   Memory.defense.trackedNukes   = {};
}

// ============================================================================
// Enemy Detection — notify via Game.notify (sends email)
// ============================================================================

function detectEnemyEntry(roomName, rs) {
  var room = Game.rooms[roomName];
  if (!room) return;

  // Filter out NPCs
  var hostiles = rs.hostiles || [];
  var filteredHostiles = [];
  for (var i = 0; i < hostiles.length; i++) {
    var owner = hostiles[i].owner ? hostiles[i].owner.username : null;
    if (owner === 'Invader' || owner === 'Source Keeper') continue;
    filteredHostiles.push(hostiles[i]);
  }
  hostiles = filteredHostiles;

  var currentIds = {};
  for (var ci = 0; ci < hostiles.length; ci++) {
    currentIds[hostiles[ci].id] = hostiles[ci];
  }

  var previousIds = Memory.defense.knownHostiles[roomName] || [];
  var previousSet = {};
  for (var p = 0; p < previousIds.length; p++) {
    previousSet[previousIds[p]] = true;
  }

  // Find new arrivals
  var newArrivals = [];
  for (var id in currentIds) {
    if (!currentIds.hasOwnProperty(id)) continue;
    if (!previousSet[id]) {
      newArrivals.push(currentIds[id]);
    }
  }

  // Update known hostiles for next tick
  var idList = [];
  for (var cid in currentIds) {
    if (currentIds.hasOwnProperty(cid)) idList.push(cid);
  }
  Memory.defense.knownHostiles[roomName] = idList;

  // Notify on new arrivals
  if (newArrivals.length > 0) {
    var cooldownUntil = Memory.defense.notifyCooldown[roomName] || 0;
    if (Game.time >= cooldownUntil) {
      var bodyReport = [];
      var hasNonTrivial = false;

      for (var n = 0; n < newArrivals.length; n++) {
        var hostile = newArrivals[n];
        var hOwner = (hostile.owner && hostile.owner.username) ? hostile.owner.username : 'unknown';
        var bodyParts = [];
        if (hostile.body) {
          var partCounts = {};
          for (var b = 0; b < hostile.body.length; b++) {
            var pType = hostile.body[b].type;
            if (!partCounts[pType]) partCounts[pType] = 0;
            partCounts[pType]++;
          }
          for (var pt in partCounts) {
            if (partCounts.hasOwnProperty(pt)) {
              bodyParts.push(partCounts[pt] + 'x' + pt);
            }
          }
          if (!(hostile.body.length === 1 && hostile.body[0].type === MOVE)) {
            hasNonTrivial = true;
          }
        }
        bodyReport.push(hOwner + ' (' + bodyParts.join(', ') + ') at ' + hostile.pos);
      }

      var msg = '[DEFENSE] Enemy creep(s) entered ' + roomName + ': ' + bodyReport.join(' | ');
      console.log(msg);
      if (hasNonTrivial) {
        Game.notify(msg, 0);
        Memory.defense.notifyCooldown[roomName] = Game.time + NOTIFY_COOLDOWN;
      }
    }
  }

  // Dismantler warning
  for (var di = 0; di < hostiles.length; di++) {
    var h = hostiles[di];
    if (!h.body) continue;
    var hasWork = false;
    for (var bi = 0; bi < h.body.length; bi++) {
      if (h.body[bi].type === WORK) { hasWork = true; break; }
    }
    if (hasWork) {
      var workCooldownUntil = Memory.defense.notifyCooldown[roomName + '_dismantle'] || 0;
      if (Game.time >= workCooldownUntil) {
        var dOwner = (h.owner && h.owner.username) ? h.owner.username : 'unknown';
        var dMsg = '[DEFENSE] WARNING: Dismantler detected in ' + roomName + ' owned by ' + dOwner + ' at ' + h.pos;
        console.log(dMsg);
        Game.notify(dMsg, 0);
        Memory.defense.notifyCooldown[roomName + '_dismantle'] = Game.time + NOTIFY_COOLDOWN;
      }
      break;
    }
  }
}

// ============================================================================
// Wall / Rampart Damage Tracking via getEventLog (player-caused only)
// ============================================================================

function trackDamageEvents(roomName) {
  var room = Game.rooms[roomName];
  if (!room) return;

  var events;
  try {
    events = room.getEventLog();
  } catch (e) {
    return;
  }

  if (!events || events.length === 0) return;

  if (!Memory.defense.damageEvents[roomName]) {
    Memory.defense.damageEvents[roomName] = {};
  }
  var roomDamage = Memory.defense.damageEvents[roomName];

  for (var i = 0; i < events.length; i++) {
    var evt = events[i];
    if (evt.event !== EVENT_ATTACK) continue;

    var targetId = evt.data.targetId;
    if (!targetId) continue;

    var target = Game.getObjectById(targetId);
    if (!target) continue;
    if (target.structureType !== STRUCTURE_WALL && target.structureType !== STRUCTURE_RAMPART) continue;

    var attackerId = evt.objectId;
    var attacker = Game.getObjectById(attackerId);
    if (!attacker) continue;
    if (attacker.my) continue;

    // Skip NPC attackers
    var attackerOwner = attacker.owner ? attacker.owner.username : null;
    if (attackerOwner === 'Invader' || attackerOwner === 'Source Keeper') continue;

    if (!roomDamage[targetId]) {
      roomDamage[targetId] = { count: 0, firstTick: Game.time, lastTick: Game.time, damage: 0 };
    }

    roomDamage[targetId].count++;
    roomDamage[targetId].lastTick = Game.time;
    roomDamage[targetId].damage += (evt.data.damage || 0);

    // First hit notification
    if (roomDamage[targetId].count === 1) {
      var firstMsg = '[DEFENSE] ' + target.structureType + ' at ' + target.pos +
        ' in ' + roomName + ' is under attack by ' + attackerOwner +
        ' (damage: ' + (evt.data.damage || 0) + ')';
      console.log(firstMsg);
      Game.notify(firstMsg, 5);
    }
  }

  // Clean up stale entries
  for (var sid in roomDamage) {
    if (!roomDamage.hasOwnProperty(sid)) continue;
    if (Game.time - roomDamage[sid].lastTick > EVENT_MEMORY_TTL) {
      delete roomDamage[sid];
    }
  }
}

// ============================================================================
// Nuke Detection
// ============================================================================

/**
 * Identify structures within blast radius of a nuke impact point.
 * Nuke deals 10M damage at ground zero and 5M within range 2.
 * Returns a summary object: { groundZero: [...], splash: [...] }
 */
function analyzeNukeImpact(room, nukePos) {
  var groundZero = [];
  var splash = [];

  // Look at ground zero
  var gzStructs = room.lookForAt(LOOK_STRUCTURES, nukePos.x, nukePos.y);
  for (var g = 0; g < gzStructs.length; g++) {
    groundZero.push({
      type: gzStructs[g].structureType,
      hits: gzStructs[g].hits,
      id: gzStructs[g].id
    });
  }

  // Look at splash zone (range 1-2)
  for (var dx = -NUKE_BLAST_RADIUS; dx <= NUKE_BLAST_RADIUS; dx++) {
    for (var dy = -NUKE_BLAST_RADIUS; dy <= NUKE_BLAST_RADIUS; dy++) {
      if (dx === 0 && dy === 0) continue;
      var nx = nukePos.x + dx;
      var ny = nukePos.y + dy;
      if (nx < 0 || nx > 49 || ny < 0 || ny > 49) continue;

      var structs = room.lookForAt(LOOK_STRUCTURES, nx, ny);
      for (var s = 0; s < structs.length; s++) {
        splash.push({
          type: structs[s].structureType,
          hits: structs[s].hits,
          id: structs[s].id
        });
      }
    }
  }

  return { groundZero: groundZero, splash: splash };
}

/**
 * Format an ETA from ticks into a human-readable string.
 */
function formatEta(ticks) {
  var totalSec = ticks * 4; // ~4 seconds per tick on average
  var hours = Math.floor(totalSec / 3600);
  var minutes = Math.floor((totalSec % 3600) / 60);
  if (hours > 0) {
    return hours + 'h ' + minutes + 'm (~' + ticks + ' ticks)';
  }
  return minutes + 'm (~' + ticks + ' ticks)';
}

/**
 * Build a compact summary of threatened structures for notification.
 */
function buildImpactSummary(impact) {
  var typeCounts = {};

  function countList(list, label) {
    for (var i = 0; i < list.length; i++) {
      var key = list[i].type;
      if (!typeCounts[key]) typeCounts[key] = { gz: 0, splash: 0 };
      typeCounts[key][label]++;
    }
  }

  countList(impact.groundZero, 'gz');
  countList(impact.splash, 'splash');

  var parts = [];
  for (var t in typeCounts) {
    if (!typeCounts.hasOwnProperty(t)) continue;
    var entry = typeCounts[t];
    var desc = t;
    if (entry.gz > 0 && entry.splash > 0) {
      desc += ' (' + entry.gz + ' direct, ' + entry.splash + ' splash)';
    } else if (entry.gz > 0) {
      desc += ' (' + entry.gz + ' direct hit)';
    } else {
      desc += ' (' + entry.splash + ' splash)';
    }
    parts.push(desc);
  }

  if (parts.length === 0) return 'No structures in blast zone';
  return parts.join(', ');
}

/**
 * Scan for incoming nukes in all owned rooms.
 * Sends notifications on first detection and at milestone thresholds.
 */
function detectNukes() {
  var tracked = Memory.defense.trackedNukes;

  // Mark all tracked nukes as unseen this scan — we'll confirm them below
  for (var tid in tracked) {
    if (tracked.hasOwnProperty(tid)) {
      tracked[tid]._seen = false;
    }
  }

  var allRooms = getRoomState.all();
  for (var roomName in allRooms) {
    if (!allRooms.hasOwnProperty(roomName)) continue;

    var room = Game.rooms[roomName];
    if (!room) continue;
    if (!room.controller || !room.controller.my) continue;

    var nukes = room.find(FIND_NUKES);
    if (!nukes || nukes.length === 0) continue;

    for (var ni = 0; ni < nukes.length; ni++) {
      var nuke = nukes[ni];
      var nukeId = nuke.id;

      if (tracked[nukeId]) {
        // Already tracking — check milestones
        tracked[nukeId]._seen = true;
        var remaining = nuke.timeToLand;
        var milestones = tracked[nukeId].milestones || {};

        for (var mi = 0; mi < NUKE_MILESTONE_TICKS.length; mi++) {
          var milestone = NUKE_MILESTONE_TICKS[mi];
          if (remaining <= milestone && !milestones[milestone]) {
            milestones[milestone] = Game.time;

            var mileMsg = '[NUKE WARNING] Nuke inbound to ' + roomName +
              ' at (' + nuke.pos.x + ',' + nuke.pos.y + ')' +
              ' — ' + formatEta(remaining) + ' remaining!' +
              ' Launched from: ' + nuke.launchRoomName;
            console.log(mileMsg);
            Game.notify(mileMsg, 0);
          }
        }

        tracked[nukeId].milestones = milestones;
        continue;
      }

      // New nuke — first detection
      var impact = analyzeNukeImpact(room, nuke.pos);
      var summary = buildImpactSummary(impact);

      tracked[nukeId] = {
        roomName: roomName,
        pos: { x: nuke.pos.x, y: nuke.pos.y },
        launchRoom: nuke.launchRoomName,
        landTick: Game.time + nuke.timeToLand,
        notifiedAt: Game.time,
        milestones: {},
        _seen: true
      };

      var nukeMsg = '[NUKE ALERT] Incoming nuke detected in ' + roomName + '!\n' +
        '  Impact: (' + nuke.pos.x + ',' + nuke.pos.y + ')\n' +
        '  Launched from: ' + nuke.launchRoomName + '\n' +
        '  ETA: ' + formatEta(nuke.timeToLand) + '\n' +
        '  Threatened structures: ' + summary;
      console.log(nukeMsg);
      Game.notify(nukeMsg, 0);
    }
  }

  // Clean up nukes that have landed or disappeared
  for (var cid in tracked) {
    if (!tracked.hasOwnProperty(cid)) continue;
    if (!tracked[cid]._seen) {
      // Nuke has landed or been removed
      var landed = tracked[cid];
      var landMsg = '[NUKE] Nuke in ' + landed.roomName +
        ' at (' + landed.pos.x + ',' + landed.pos.y + ')' +
        ' from ' + landed.launchRoom + ' has landed or expired.';
      console.log(landMsg);
      Game.notify(landMsg, 0);
      delete tracked[cid];
    } else {
      // Clean up internal flag
      delete tracked[cid]._seen;
    }
  }
}

// ============================================================================
// BFS: Find contiguous cluster from a single starting structure
// ============================================================================

function findContiguousCluster(startId, room) {
  var start = Game.getObjectById(startId);
  if (!start) return [];

  var visited = {};
  var cluster = [];
  var queue = [start];
  visited[start.id] = true;

  while (queue.length > 0) {
    var current = queue.shift();
    cluster.push(current.id);

    var cx = current.pos.x;
    var cy = current.pos.y;

    for (var dx = -CLUSTER_RANGE; dx <= CLUSTER_RANGE; dx++) {
      for (var dy = -CLUSTER_RANGE; dy <= CLUSTER_RANGE; dy++) {
        if (dx === 0 && dy === 0) continue;
        var nx = cx + dx;
        var ny = cy + dy;
        if (nx < 0 || nx > 49 || ny < 0 || ny > 49) continue;

        var structs = room.lookForAt(LOOK_STRUCTURES, nx, ny);
        for (var s = 0; s < structs.length; s++) {
          var st = structs[s];
          if (visited[st.id]) continue;
          if (st.structureType !== STRUCTURE_WALL && st.structureType !== STRUCTURE_RAMPART) continue;
          visited[st.id] = true;
          queue.push(st);
        }
      }
    }
  }

  return cluster;
}

// ============================================================================
// Build ALL wall/rampart clusters in a room (topology only, cached)
// Cache is created on first need after an attack and explicitly cleared
// when all repair orders for the room are resolved. No TTL — the caller
// is responsible for cache lifecycle via clearClusterCache().
// ============================================================================

function getAllClusters(roomName) {
  var cached = Memory.defense.clusterCache[roomName];
  if (cached) {
    return cached.clusters;
  }

  var room = Game.rooms[roomName];
  if (!room) return [];

  var rs = getRoomState.get(roomName);
  if (!rs || !rs.structuresByType) return [];

  var allBarriers = [];
  var walls = rs.structuresByType[STRUCTURE_WALL] || [];
  var ramps = rs.structuresByType[STRUCTURE_RAMPART] || [];
  for (var w = 0; w < walls.length; w++) allBarriers.push(walls[w]);
  for (var r = 0; r < ramps.length; r++) allBarriers.push(ramps[r]);

  if (allBarriers.length === 0) return [];

  var visited = {};
  var clusters = [];

  for (var bi = 0; bi < allBarriers.length; bi++) {
    var barrier = allBarriers[bi];
    if (visited[barrier.id]) continue;

    var clusterIds = [];
    var queue = [barrier];
    visited[barrier.id] = true;

    while (queue.length > 0) {
      var current = queue.shift();
      clusterIds.push(current.id);

      var cx = current.pos.x;
      var cy = current.pos.y;

      for (var dx = -CLUSTER_RANGE; dx <= CLUSTER_RANGE; dx++) {
        for (var dy = -CLUSTER_RANGE; dy <= CLUSTER_RANGE; dy++) {
          if (dx === 0 && dy === 0) continue;
          var nx = cx + dx;
          var ny = cy + dy;
          if (nx < 0 || nx > 49 || ny < 0 || ny > 49) continue;

          var structs = room.lookForAt(LOOK_STRUCTURES, nx, ny);
          for (var si = 0; si < structs.length; si++) {
            var st = structs[si];
            if (visited[st.id]) continue;
            if (st.structureType !== STRUCTURE_WALL && st.structureType !== STRUCTURE_RAMPART) continue;
            visited[st.id] = true;
            queue.push(st);
          }
        }
      }
    }

    // Topology only — no hits stored in cache
    clusters.push({ ids: clusterIds });
  }

  Memory.defense.clusterCache[roomName] = {
    clusters: clusters
  };

  return clusters;
}

/**
 * Explicitly clear the cluster topology cache for a room.
 * Called when all repair orders are resolved — the cache only exists
 * while repairs are active.
 */
function clearClusterCache(roomName) {
  delete Memory.defense.clusterCache[roomName];
}

// ============================================================================
// Get the minimum hits and corresponding structure ID from a cluster
// (live query — never cached)
// ============================================================================

function getClusterMinHits(ids) {
  var minHits = Infinity;
  var minId = null;

  for (var i = 0; i < ids.length; i++) {
    var s = Game.getObjectById(ids[i]);
    if (!s) continue;
    if (typeof s.hits !== 'number') continue;
    if (s.hits < minHits) {
      minHits = s.hits;
      minId = s.id;
    }
  }

  return { minHits: minHits, minId: minId };
}

// ============================================================================
// Calculate the median HP of all walls and ramparts in a room
// ============================================================================

function getRoomMedianHits(roomName) {
  var rs = getRoomState.get(roomName);
  if (!rs || !rs.structuresByType) return 0;

  var hitsArr = [];
  var walls = rs.structuresByType[STRUCTURE_WALL] || [];
  var ramps = rs.structuresByType[STRUCTURE_RAMPART] || [];

  for (var w = 0; w < walls.length; w++) {
    if (typeof walls[w].hits === 'number') {
      hitsArr.push(walls[w].hits);
    }
  }
  for (var r = 0; r < ramps.length; r++) {
    if (typeof ramps[r].hits === 'number') {
      hitsArr.push(ramps[r].hits);
    }
  }

  if (hitsArr.length === 0) return 0;
  if (hitsArr.length === 1) return hitsArr[0];

  hitsArr.sort(function(a, b) { return a - b; });

  var mid = Math.floor(hitsArr.length / 2);
  if (hitsArr.length % 2 === 0) {
    return Math.floor((hitsArr[mid - 1] + hitsArr[mid]) / 2);
  } else {
    return hitsArr[mid];
  }
}

// ============================================================================
// Find which cluster a structure belongs to
// ============================================================================

function findClusterContaining(structureId, clusters) {
  for (var i = 0; i < clusters.length; i++) {
    if (clusters[i].ids.indexOf(structureId) !== -1) {
      return clusters[i];
    }
  }
  return null;
}

// ============================================================================
// Determine if a cluster is the weakest in the room
// Queries hits live for only the clusters being compared.
// ============================================================================

function isWeakestCluster(clusterIds, allClusters) {
  if (!clusterIds || !allClusters || allClusters.length === 0) return false;
  if (allClusters.length === 1) return true;

  var myStats = getClusterMinHits(clusterIds);

  for (var i = 0; i < allClusters.length; i++) {
    var other = allClusters[i];
    if (other.ids[0] === clusterIds[0]) continue;
    var otherStats = getClusterMinHits(other.ids);
    if (otherStats.minHits < myStats.minHits) return false;
  }

  return true;
}

// ============================================================================
// Evaluate damage events and create repair orders
// Only builds cluster map when there's a damage event at threshold or
// active repair orders needing re-evaluation.
// ============================================================================

function evaluateRepairOrders(roomName) {
  var roomDamage = Memory.defense.damageEvents[roomName];
  if (!Memory.defense.repairOrders[roomName]) {
    Memory.defense.repairOrders[roomName] = [];
  }
  var orders = Memory.defense.repairOrders[roomName];

  var room = Game.rooms[roomName];
  if (!room) return;

  // ---- Early exit: check if we actually need cluster computation ----
  var hasThresholdDamage = false;
  if (roomDamage) {
    for (var checkSid in roomDamage) {
      if (roomDamage.hasOwnProperty(checkSid) && roomDamage[checkSid].count >= DAMAGE_THRESHOLD) {
        hasThresholdDamage = true;
        break;
      }
    }
  }

  var hasActiveOrders = orders.length > 0;

  if (!hasThresholdDamage && !hasActiveOrders) {
    clearClusterCache(roomName);
    return;
  }

  // Count existing defense repair creeps (alive + spawning)
  var existingCount = 0;
  for (var cname in Game.creeps) {
    var c = Game.creeps[cname];
    if (!c.memory) continue;
    if (c.memory.role === 'defenseRepair' && c.memory.homeRoom === roomName) {
      existingCount++;
    }
  }
  var rs = getRoomState.get(roomName);
  if (rs && rs.structuresByType && rs.structuresByType[STRUCTURE_SPAWN]) {
    for (var si = 0; si < rs.structuresByType[STRUCTURE_SPAWN].length; si++) {
      var sp = rs.structuresByType[STRUCTURE_SPAWN][si];
      if (sp.my && sp.spawning) {
        var mem = Memory.creeps[sp.spawning.name];
        if (mem && mem.role === 'defenseRepair' && mem.homeRoom === roomName) {
          existingCount++;
        }
      }
    }
  }

  // Build cluster topology (cached, no hits stored)
  var allClusters = getAllClusters(roomName);
  if (allClusters.length === 0) return;

  // Check each damaged structure that has hit the threshold
  if (roomDamage) {
    for (var sid in roomDamage) {
      if (!roomDamage.hasOwnProperty(sid)) continue;
      var entry = roomDamage[sid];

      if (entry.count < DAMAGE_THRESHOLD) continue;

      // Don't exceed max
      if (existingCount >= MAX_DEFENSE_REPAIRS) continue;

      // Check if already covered by an existing order
      var alreadyCovered = false;
      for (var oi = 0; oi < orders.length; oi++) {
        if (orders[oi].clusterIds && orders[oi].clusterIds.indexOf(sid) !== -1) {
          alreadyCovered = true;
          break;
        }
      }
      if (alreadyCovered) continue;

      // Find which cluster this damaged structure belongs to
      var damagedCluster = findClusterContaining(sid, allClusters);
      if (!damagedCluster) {
        var bfsIds = findContiguousCluster(sid, room);
        if (bfsIds.length === 0) continue;
        damagedCluster = { ids: bfsIds };
      }

      var isSolo = (damagedCluster.ids.length === 1);

      // Query hits live only for the clusters we're comparing
      var damagedStats = getClusterMinHits(damagedCluster.ids);

      if (isSolo) {
        // Solo structure: spawn if below room median
        var median = getRoomMedianHits(roomName);
        if (damagedStats.minHits >= median) {
          console.log('[DefenseMonitor] Solo structure in ' + roomName + ' (hits: ' +
            damagedStats.minHits + ') is at or above median (' + median + '). Clearing alert.');
          delete roomDamage[sid];
          continue;
        }
      } else {
        // Multi-structure cluster: only spawn if it's the weakest section
        if (!isWeakestCluster(damagedCluster.ids, allClusters)) {
          console.log('[DefenseMonitor] Damaged cluster in ' + roomName + ' (minHits: ' +
            damagedStats.minHits + ') is NOT the weakest section. Clearing alert.');
          delete roomDamage[sid];
          continue;
        }
      }

      // Create repair order
      var order = {
        clusterId: damagedCluster.ids[0],
        clusterIds: damagedCluster.ids,
        solo: isSolo,
        assignedCreep: null,
        createdAt: Game.time
      };

      orders.push(order);
      existingCount++;

      var modeStr = isSolo ? 'solo (target: median)' : 'weakest cluster';
      var notifyMsg = '[DEFENSE] Repair order created in ' + roomName +
        ' — ' + modeStr + ' (minHits: ' + damagedStats.minHits + ', ' +
        damagedCluster.ids.length + ' structures). ' +
        'Damage events: ' + entry.count + ', total damage: ' + entry.damage;
      console.log(notifyMsg);
      Game.notify(notifyMsg, 5);

      // Clear damage counter so we don't re-trigger from the same burst
      delete roomDamage[sid];
    }
  }

  // Clean up orders
  for (var ri = orders.length - 1; ri >= 0; ri--) {
    var ord = orders[ri];

    // If creep was assigned but is now dead
    if (ord.assignedCreep && !Game.creeps[ord.assignedCreep]) {
      ord.assignedCreep = null;

      // Re-evaluate: does this order still need a bot?
      var stillNeeded = false;

      if (ord.solo) {
        var soloStruct = Game.getObjectById(ord.clusterId);
        var currentMedian = getRoomMedianHits(roomName);
        if (soloStruct && typeof soloStruct.hits === 'number' && soloStruct.hits < currentMedian) {
          stillNeeded = true;
        }
      } else {
        if (isWeakestCluster(ord.clusterIds, allClusters)) {
          stillNeeded = true;
        }
      }

      if (!stillNeeded) {
        console.log('[DefenseMonitor] Repair order in ' + roomName +
          ' no longer needed. Removing.');
        orders.splice(ri, 1);
        continue;
      }
    }

    // Stale order cleanup (no creep assigned after 500 ticks)
    if (!ord.assignedCreep && Game.time - ord.createdAt > 500) {
      orders.splice(ri, 1);
    }
  }

  // All repairs resolved — clear cluster cache, back to peacetime
  if (orders.length === 0) {
    clearClusterCache(roomName);
  }
}

// ============================================================================
// Main run function — called once per tick
// ============================================================================

function run() {
  ensureMemory();

  var allRooms = getRoomState.all();
  for (var roomName in allRooms) {
    if (!allRooms.hasOwnProperty(roomName)) continue;

    var rs = allRooms[roomName];
    var room = Game.rooms[roomName];
    if (!room) continue;

    // Only monitor owned rooms
    if (!room.controller || !room.controller.my) continue;

    // 1. Detect enemy creep entry → Game.notify (skip NPCs)
    var hostileCount = rs.hostiles ? rs.hostiles.length : 0;
    var hadHostiles = Memory.defense.knownHostiles[roomName] &&
                      Memory.defense.knownHostiles[roomName].length > 0;
    if (hostileCount > 0 || hadHostiles || Game.time % 7 === 0) {
      detectEnemyEntry(roomName, rs);
    }

    // 2. Track wall/rampart damage via event log (every tick)
    trackDamageEvents(roomName);

    // 3. Evaluate repair orders with cluster comparison
    if (Game.time % 3 === 0) {
      evaluateRepairOrders(roomName);
    }
  }

  // 4. Nuke detection (runs across all rooms, throttled)
  if (Game.time % NUKE_SCAN_INTERVAL === 0) {
    detectNukes();
  }
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  run: run,
  getAllClusters: getAllClusters,
  clearClusterCache: clearClusterCache,
  getClusterMinHits: getClusterMinHits,
  getRoomMedianHits: getRoomMedianHits,
  isWeakestCluster: isWeakestCluster,
  findClusterContaining: findClusterContaining,
  findContiguousCluster: findContiguousCluster,
  detectNukes: detectNukes,
  analyzeNukeImpact: analyzeNukeImpact,
  DAMAGE_THRESHOLD: DAMAGE_THRESHOLD,
  MAX_DEFENSE_REPAIRS: MAX_DEFENSE_REPAIRS
};