// linkManager.js
/**
 * Link manager:
 * - Donor links feed storage links only (keep donors near 0).
 * - Storage links feed recipient (controller) links only (keep recipients full).
 * - Minimum transfer is 5.
 * - At most one successful send per room per tick.
 *
 * Uses getRoomState for cached structure lookups.
 */

var getRoomState = require('getRoomState');
var singleSourceRoom = require('singleSourceRoom');

// Heap cache: survives between ticks, never serialized to Memory.
// Structure: { [roomName]: { donors: [], storage: [], recipients: [], lastUpdated: tick } }
var _linkCache = {};

function runLinks() {
  const MIN_TRANSFER = 200;
  const CACHE_DURATION = 50; // Refresh link classifications every 50 ticks

  function energyOf(link) {
    if (link && link.store && typeof link.store.getUsedCapacity === 'function') {
      var used = link.store.getUsedCapacity(RESOURCE_ENERGY);
      return typeof used === 'number' ? used : 0;
    }
    if (link && typeof link.energy === 'number') return link.energy;
    return 0;
  }

  function freeOf(link) {
    if (link && link.store && typeof link.store.getFreeCapacity === 'function') {
      var free = link.store.getFreeCapacity(RESOURCE_ENERGY);
      return typeof free === 'number' ? free : 0;
    }
    if (link && typeof link.energyCapacity === 'number' && typeof link.energy === 'number') {
      return link.energyCapacity - link.energy;
    }
    return 0;
  }

  function canSend(sender) {
    if (!sender) return false;
    if (sender.cooldown && sender.cooldown > 0) return false;
    return energyOf(sender) >= MIN_TRANSFER;
  }

  function canReceive(target) {
    if (!target) return false;
    return freeOf(target) >= MIN_TRANSFER;
  }

  // Ensure getRoomState is initialized
  getRoomState.init();
  var allRoomStates = getRoomState.all();

  for (var roomName in allRoomStates) {
    var roomState = allRoomStates[roomName];
    if (!roomState) continue;

    var controller = roomState.controller;
    var storage = roomState.storage;
    var sources = roomState.sources || [];

    // Get links from cached structures
    var structuresByType = roomState.structuresByType || {};
    var allLinks = structuresByType[STRUCTURE_LINK] || [];

    // Skip if no links
    if (allLinks.length === 0) continue;

    // === CHAIN MODE for single-source rooms ===
    if (singleSourceRoom.isSingleSourceActive(roomName)) {
        var chain = singleSourceRoom.getLinkChain(roomName);
        if (chain && chain.length >= 2) {
            for (var ci = 0; ci < chain.length - 1; ci++) {
                var sender = Game.getObjectById(chain[ci]);
                var receiver = Game.getObjectById(chain[ci + 1]);
                if (!sender || !receiver) continue;
                if (sender.cooldown && sender.cooldown > 0) continue;
                if (energyOf(sender) < MIN_TRANSFER) continue;
                if (freeOf(receiver) < MIN_TRANSFER) continue;
                var chainRes = sender.transferEnergy(receiver);
                if (chainRes === OK) break; // one transfer per room per tick
            }
            continue;
        }
    }

    var room = Game.rooms[roomName];
    if (!room) continue;

    // Rebuild heap cache if missing or stale
    var cached = _linkCache[roomName];
    if (!cached || (Game.time - cached.lastUpdated) >= CACHE_DURATION) {
      cached = { donors: [], storage: [], recipients: [], lastUpdated: Game.time };

      for (var i = 0; i < allLinks.length; i++) {
        var link = allLinks[i];

        // Classify as recipient (near controller)
        if (controller && link.pos.inRangeTo(controller, 2)) {
          cached.recipients.push(link.id);
        }
        // Classify as storage link
        else if (storage && link.pos.inRangeTo(storage, 2)) {
          cached.storage.push(link.id);
        }
        // Classify as donor (near source)
        else {
          for (var s = 0; s < sources.length; s++) {
            if (link.pos.inRangeTo(sources[s], 3)) {
              cached.donors.push(link.id);
              break;
            }
          }
        }
      }

      _linkCache[roomName] = cached;
    }

    // Resolve IDs to live objects each tick (getObjectById is cheap)
    var donors = [];
    var storageLinks = [];
    var recipients = [];

    for (var d = 0; d < cached.donors.length; d++) {
      var donorLink = Game.getObjectById(cached.donors[d]);
      if (donorLink) donors.push(donorLink);
    }

    for (var st = 0; st < cached.storage.length; st++) {
      var storageLink = Game.getObjectById(cached.storage[st]);
      if (storageLink) storageLinks.push(storageLink);
    }

    for (var r = 0; r < cached.recipients.length; r++) {
      var recipientLink = Game.getObjectById(cached.recipients[r]);
      if (recipientLink) recipients.push(recipientLink);
    }

    // Find best donor (highest energy that can send)
    var bestDonor = null;
    var bestDonorEnergy = 0;
    for (var dIdx = 0; dIdx < donors.length; dIdx++) {
      var donor = donors[dIdx];
      if (canSend(donor)) {
        var donorEnergy = energyOf(donor);
        if (donorEnergy > bestDonorEnergy) {
          bestDonor = donor;
          bestDonorEnergy = donorEnergy;
        }
      }
    }

    // Find best storage target (most free space that can receive)
    var bestStorage = null;
    var bestStorageFree = 0;
    for (var sIdx = 0; sIdx < storageLinks.length; sIdx++) {
      var storageTarget = storageLinks[sIdx];
      if (canReceive(storageTarget)) {
        var storageFree = freeOf(storageTarget);
        if (storageFree > bestStorageFree) {
          bestStorage = storageTarget;
          bestStorageFree = storageFree;
        }
      }
    }

    // Try donor → storage (1 intent max)
    if (bestDonor && bestStorage) {
      var res = bestDonor.transferEnergy(bestStorage);
      if (res === OK) continue; // One intent per room, move to next room
    }

    // Try storage → recipient (only if no donor sent)
    var bestStorageSender = null;
    var bestStorageSenderEnergy = 0;
    for (var seIdx = 0; seIdx < storageLinks.length; seIdx++) {
      var storageSender = storageLinks[seIdx];
      if (canSend(storageSender)) {
        var senderEnergy = energyOf(storageSender);
        if (senderEnergy > bestStorageSenderEnergy) {
          bestStorageSender = storageSender;
          bestStorageSenderEnergy = senderEnergy;
        }
      }
    }

    var bestRecipient = null;
    var bestRecipientFree = 0;
    for (var rIdx = 0; rIdx < recipients.length; rIdx++) {
      var recipient = recipients[rIdx];
      if (canReceive(recipient)) {
        var recipientFree = freeOf(recipient);
        if (recipientFree > bestRecipientFree) {
          bestRecipient = recipient;
          bestRecipientFree = recipientFree;
        }
      }
    }

    if (bestStorageSender && bestRecipient) {
      bestStorageSender.transferEnergy(bestRecipient);
      // One intent per room (implicit continue at end of loop)
    }
  }
}

// Expose cache invalidation for when structures change (e.g. new link placed)
function invalidateRoom(roomName) {
  delete _linkCache[roomName];
}

module.exports = {
  run: runLinks,
  invalidateRoom: invalidateRoom
};