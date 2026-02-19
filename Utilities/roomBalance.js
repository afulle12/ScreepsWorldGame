// roomBalance.js
// Purpose: Balance energy across owned rooms using terminals.
// Behavior:
// - Recipients: rooms with storage energy below 300,000 and with a terminal.
// - Donors: rooms with storage energy above 450,000 and with a terminal.
// - Transfer 100,000 ENERGY from the highest-energy donor to the lowest-energy recipient.
// - If a second recipient exists, transfer 100,000 ENERGY from the second-highest donor to the second-lowest recipient.
// - Skips any room currently busy with a terminal transfer (as source or destination).
// - Sends an email notification via Game.notify after each successful transfer.
// Notes:
// - No optional chaining used (Screeps-compatible).
// - All transfers are initiated exclusively via terminalManager.transferStuff(fromRoom, toRoom, 'energy', amount).
// - Tick interval is controlled from main; this file has no internal gating.

const terminalManager = require('terminalManager');

const LOW_STORAGE_THRESHOLD = 300000;
const HIGH_STORAGE_THRESHOLD = 400000;
const TRANSFER_AMOUNT = 15000;

function isSuccess(result) {
  // Accept common "success" indicators; we can tighten this if your terminalManager differs.
  // Screeps OK is 0; some wrappers return OK or true.
  return result === OK || result === 0 || result === true || result === 'OK' || result === 'queued';
}

function notifyTransfer(fromRoom, toRoom, amount) {
  // Group identical messages for 60 minutes to reduce noise; each message includes tick so grouping rarely triggers.
  Game.notify(
    '[RoomBalance] Transfer started: ' + fromRoom + ' -> ' + toRoom +
    ' x ' + amount + ' ENERGY at tick ' + Game.time,
    60
  );
}

const roomBalance = {
  run: function() {
    // Gather room data
    var roomsData = [];
    for (var roomName in Game.rooms) {
      var room = Game.rooms[roomName];
      if (!room || !room.controller || !room.controller.my) continue;

      var storageEnergy = 0;
      if (room.storage && room.storage.store) {
        var v = room.storage.store[RESOURCE_ENERGY];
        storageEnergy = typeof v === 'number' ? v : 0;
      }

      var hasTerminal = !!room.terminal;
      roomsData.push({
        name: roomName,
        energy: storageEnergy,
        hasTerminal: hasTerminal
      });
    }

    if (roomsData.length === 0) return;

    // Determine recipients (low rooms) and donors (rich rooms)
    var recipients = roomsData.filter(function(r) {
      return r.energy < LOW_STORAGE_THRESHOLD &&
             r.hasTerminal;
    });

    var donors = roomsData.filter(function(d) {
      return d.energy > HIGH_STORAGE_THRESHOLD &&
             d.hasTerminal;
    });

    if (recipients.length === 0 || donors.length === 0) return;

    // Sort donors by storage energy descending (highest first)
    donors.sort(function(a, b) { return b.energy - a.energy; });

    // Sort recipients by storage energy ascending (lowest first)
    recipients.sort(function(a, b) { return a.energy - b.energy; });

    // Avoid rooms that are currently busy with transfers
    function isBusy(rn) {
      return terminalManager.isRoomBusyWithTransfer(rn);
    }

    recipients = recipients.filter(function(r) { return !isBusy(r.name); });
    donors = donors.filter(function(d) { return !isBusy(d.name); });

    if (recipients.length === 0 || donors.length === 0) return;

    // First transfer: highest donor -> lowest recipient
    if (recipients.length >= 1 && donors.length >= 1) {
      var to1 = recipients[0].name;
      var from1 = donors[0].name;
      if (from1 !== to1 && !isBusy(to1) && !isBusy(from1)) {
        // EXACT signature match: transferStuff('DONORROOM', 'RECEIVINGROOM', 'energy', 100000)
        var res1 = terminalManager.transferStuff(from1, to1, 'energy', TRANSFER_AMOUNT);
        console.log('[RoomBalance] ' + from1 + ' -> ' + to1 + ' x ' + TRANSFER_AMOUNT + ' ENERGY | ' + res1);
        if (isSuccess(res1)) {
          //notifyTransfer(from1, to1, TRANSFER_AMOUNT);
        }
      }
    }

    // Second transfer: second-highest donor -> second-lowest recipient
    if (recipients.length >= 2 && donors.length >= 2) {
      var to2 = recipients[1].name;
      var from2 = donors[1].name;
      if (from2 !== to2 && !isBusy(to2) && !isBusy(from2)) {
        var res2 = terminalManager.transferStuff(from2, to2, 'energy', TRANSFER_AMOUNT);
        console.log('[RoomBalance] ' + from2 + ' -> ' + to2 + ' x ' + TRANSFER_AMOUNT + ' ENERGY | ' + res2);
        if (isSuccess(res2)) {
          //notifyTransfer(from2, to2, TRANSFER_AMOUNT);
        }
      }
    }
  }
};

module.exports = roomBalance;
