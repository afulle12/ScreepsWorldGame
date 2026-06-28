// roomBalance.js
// Purpose: Balance energy across owned rooms using terminals.
// Behavior:
// - Recipients: rooms with storage energy below 300,000 and with a terminal.
// - Donors: rooms with storage energy above 450,000 and with a terminal.
// - Transfer 100,000 ENERGY from the highest-energy donor to the lowest-energy recipient.
// - If a second recipient exists, transfer 100,000 ENERGY from the second-highest donor to the second-lowest recipient.
// - Skips any room currently busy with a terminal transfer (as source or destination).
// - Sends an email notification via Game.notify after each successful transfer.
// - If a room's storage energy exceeds 825,000 and no opportunistic sell order exists for it,
//   creates an opportunistic sell order to sell the excess down to 825,000.

const terminalManager = require('terminalManager');
const opportunisticSell = require('opportunisticSell');

const LOW_STORAGE_THRESHOLD = 300000;
const HIGH_STORAGE_THRESHOLD = 400000;
const TRANSFER_AMOUNT = 15000;
const SELL_THRESHOLD = 825000;

function isSuccess(result) {
  return result === OK || result === 0 || result === true || result === 'OK' || result === 'queued';
}

function notifyTransfer(fromRoom, toRoom, amount) {
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

    // ---- Opportunistic sell for rooms above 825k ----
    var sellRequests = (Memory.opportunisticSell && Memory.opportunisticSell.requests)
      ? Memory.opportunisticSell.requests
      : {};

    for (var si = 0; si < roomsData.length; si++) {
      var rd = roomsData[si];
      if (rd.energy > SELL_THRESHOLD && rd.hasTerminal) {
        var sellKey = rd.name + '_energy';
        if (!sellRequests[sellKey]) {
          var sellAmount = rd.energy - SELL_THRESHOLD;
          opportunisticSell.setup(rd.name, RESOURCE_ENERGY, sellAmount, true);
          console.log('[RoomBalance] Created opportunistic sell for ' + rd.name +
            ': ' + sellAmount + ' energy (storage at ' + rd.energy + ')');
        }
      }
    }

    // ---- Normal balancing logic ----
    var recipients = roomsData.filter(function(r) {
      return r.energy < LOW_STORAGE_THRESHOLD &&
             r.hasTerminal;
    });

    var donors = roomsData.filter(function(d) {
      return d.energy > HIGH_STORAGE_THRESHOLD &&
             d.hasTerminal;
    });

    if (recipients.length === 0 || donors.length === 0) return;

    donors.sort(function(a, b) { return b.energy - a.energy; });
    recipients.sort(function(a, b) { return a.energy - b.energy; });

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
        var res1 = terminalManager.transferStuff(from1, to1, 'energy', TRANSFER_AMOUNT);
        console.log('[RoomBalance] ' + from1 + ' -> ' + to1 + ' x ' + TRANSFER_AMOUNT + ' ENERGY | ' + res1);
      }
    }

    // Second transfer: second-highest donor -> second-lowest recipient
    if (recipients.length >= 2 && donors.length >= 2) {
      var to2 = recipients[1].name;
      var from2 = donors[1].name;
      if (from2 !== to2 && !isBusy(to2) && !isBusy(from2)) {
        var res2 = terminalManager.transferStuff(from2, to2, 'energy', TRANSFER_AMOUNT);
        console.log('[RoomBalance] ' + from2 + ' -> ' + to2 + ' x ' + TRANSFER_AMOUNT + ' ENERGY | ' + res2);
      }
    }
  }
};

module.exports = roomBalance;