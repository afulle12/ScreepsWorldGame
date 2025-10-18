// maintenanceScanner.js
// Purpose: Scan all visible rooms and estimate energy per tick (en/tick) needed to offset decay
// across roads (plains/swamp), ramparts (yours only), containers (claimed vs unclaimed/reserved),
// and tunnels (if present / flagged).
// No optional chaining is used.
// Console:
//   - Itemized: require('maintenanceScanner').print()
//   - Raw data: require('maintenanceScanner').scan()
// Notes:
//   - We iterate Game.rooms and room.find(FIND_STRUCTURES) so neutral structures (roads/containers)
//     are included. Game.structures alone only includes your owned structures. 【1】【2】
//   - Containers decay slower in claimed rooms and faster in unclaimed or reserved rooms.
//   - You can mark tunnel ids in Memory.maintScan.tunnelIds = ['id1','id2'].
//   - Only your ramparts are counted.

var EPT = {
  road: { plain: 0.001, swamp: 0.005 },
  rampart: 0.030,
  container_claimed: 0.100,
  container_unclaimed: 0.500,
  tunnel: 0.150
};

function isClaimedRoom(room) {
  if (!room) return false;
  var c = room.controller;
  if (!c) return false;
  return c.my === true; // owned by you 【3】
}

function isReservedRoom(room) {
  if (!room) return false;
  var c = room.controller;
  if (!c) return false;
  return !!c.reservation;
}

function classifyRoadTerrain(structure) {
  var terrain = structure.room.getTerrain();
  var t = terrain.get(structure.pos.x, structure.pos.y);
  if ((t & TERRAIN_MASK_SWAMP) === TERRAIN_MASK_SWAMP) return 'swamp';
  return 'plain';
}

function isTunnelStructure(structure) {
  if (typeof STRUCTURE_TUNNEL !== 'undefined') {
    if (structure.structureType === STRUCTURE_TUNNEL) return true;
  }
  if (structure.structureType === 'tunnel') return true;

  if (Memory && Memory.maintScan && Array.isArray(Memory.maintScan.tunnelIds)) {
    for (var i = 0; i < Memory.maintScan.tunnelIds.length; i++) {
      if (structure.id === Memory.maintScan.tunnelIds[i]) return true;
    }
  }
  return false;
}

// Data shape:
// { totalEpt, rooms: { <roomName>: { totalEpt, count, types: { <typeKey>: { ept, count } } } } }
function scan() {
  var summary = { totalEpt: 0, rooms: {} };

  function add(roomName, typeKey, ept) {
    if (!summary.rooms[roomName]) {
      summary.rooms[roomName] = { totalEpt: 0, count: 0, types: {} };
    }
    var r = summary.rooms[roomName];
    r.totalEpt += ept;
    r.count += 1;
    if (!r.types[typeKey]) r.types[typeKey] = { ept: 0, count: 0 };
    r.types[typeKey].ept += ept;
    r.types[typeKey].count += 1;

    summary.totalEpt += ept;
  }

  // Iterate all visible rooms so we include neutral structures like roads/containers. 【2】
  for (var rn in Game.rooms) {
    var room = Game.rooms[rn];
    if (!room) continue;

    var structs = room.find(FIND_STRUCTURES); // all structures in the room (visible to you)
    for (var i = 0; i < structs.length; i++) {
      var s = structs[i];

      // Tunnels (custom/seasonal or manual list)
      if (isTunnelStructure(s)) {
        add(rn, 'tunnel', EPT.tunnel);
        continue;
      }

      if (s.structureType === STRUCTURE_ROAD) {
        var rt = classifyRoadTerrain(s);
        if (rt === 'swamp') add(rn, 'road_swamp', EPT.road.swamp);
        else add(rn, 'road_plain', EPT.road.plain);
        continue;
      }

      if (s.structureType === STRUCTURE_RAMPART) {
        // Count only your ramparts
        if (s.my === true) add(rn, 'rampart', EPT.rampart);
        continue;
      }

      if (s.structureType === STRUCTURE_CONTAINER) {
        var claimed = isClaimedRoom(room);
        var reserved = isReservedRoom(room);
        if (claimed) add(rn, 'container_claimed', EPT.container_claimed);
        else add(rn, 'container_unclaimed', EPT.container_unclaimed); // unclaimed or reserved
        continue;
      }
    }
  }

  // Round to 3 decimals
  summary.totalEpt = Math.round(summary.totalEpt * 1000) / 1000;
  for (var k in summary.rooms) {
    var r = summary.rooms[k];
    r.totalEpt = Math.round(r.totalEpt * 1000) / 1000;
    for (var tk in r.types) {
      r.types[tk].ept = Math.round(r.types[tk].ept * 1000) / 1000;
    }
  }
  return summary;
}

function print() {
  var data = scan();

  console.log('[maint-scan] Total maintenance: ' + data.totalEpt + ' en/tick');

  var rooms = [];
  for (var rn in data.rooms) rooms.push({ name: rn, info: data.rooms[rn] });
  rooms.sort(function(a, b) { return b.info.totalEpt - a.info.totalEpt; });

  console.log('[maint-scan] Rooms (desc by en/tick):');
  for (var i = 0; i < rooms.length; i++) {
    var r = rooms[i];
    console.log('  - ' + r.name + ': ' + r.info.totalEpt + ' en/tick (structures ' + r.info.count + ')');

    var types = [];
    for (var tk in r.info.types) types.push({ key: tk, ept: r.info.types[tk].ept, count: r.info.types[tk].count });
    types.sort(function(a, b) { return b.ept - a.ept; });

    for (var j = 0; j < types.length; j++) {
      var t = types[j];
      console.log('      - ' + t.key + ': ' + t.ept + ' en/tick (count ' + t.count + ')');
    }
  }
  return;
}

module.exports = { scan: scan, print: print };

if (typeof global !== 'undefined') {
  global.maintScan = function() { return print(); };
}
