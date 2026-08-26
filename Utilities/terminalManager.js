// LLM: Read docs/codex.js before reviewing or changing this file.
// terminalManager.js
// Console globals: transferStuff, terminalStatus, whyTerminal, cancelTerminalOperation, isRoomBusy, broadcastEnergy, storageToTerminal, terminalToStorage
// Example: transferStuff('E1S1', 'E3S3', 'energy', 3000) - Queue inter-room terminal transfer
// Example: terminalStatus('E1S1') - Display terminal inventory, energy, and cooldown
// Example: whyTerminal('E1S1') - Explain current routing or idle state for room terminal
// Example: cancelTerminalOperation('E1S1') - Cancel queued terminal transfer for room
// Example: isRoomBusy('E1S1') - Check if terminal is actively transferring or on cooldown
// Example: broadcastEnergy('E1S1', 50000) - Distribute excess energy to rooms needing supply
// Example: storageToTerminal('E1S1', 'energy', 10000) - Move resources from storage to terminal
// Example: terminalToStorage('E1S1', 'energy', 10000) - Move resources from terminal to storage
const getRoomState = require("getRoomState");
var singleSourceRoom = require("singleSourceRoom");
var storageManager = require("storageManager");
var spawnManager = require("spawnManager");
var roomSuspender = require("roomSuspender");
var util = require("util");
var memoryManager = require("memoryManager");
const TERMINAL_BOT_ENERGY_THRESHOLD = 1e5;
const LOCAL_NO_PROGRESS_TIMEOUT = 1e3;
const terminalManager = {
  init: function() {
    if (!Memory.terminalManager) {
      Memory.terminalManager = {
        operations: [],
        bots: [],
        lastMaintenanceTick: null,
        lastCompletedCleanupTick: null,
        settings: {
          emailNotifications: true,
          runBotsFromManager: false,
          energyHighThreshold: 1e5,
          energyTargetLevel: 2e4
        }
      };
    } else {
      if (!Memory.terminalManager.settings) Memory.terminalManager.settings = {};
      if (typeof Memory.terminalManager.settings.emailNotifications !== "boolean") Memory.terminalManager.settings.emailNotifications = true;
      if (typeof Memory.terminalManager.settings.runBotsFromManager !== "boolean") Memory.terminalManager.settings.runBotsFromManager = false;
      if (typeof Memory.terminalManager.settings.energyHighThreshold !== "number") Memory.terminalManager.settings.energyHighThreshold = 1e5;
      if (typeof Memory.terminalManager.settings.energyTargetLevel !== "number") Memory.terminalManager.settings.energyTargetLevel = 2e4;
      if (!Array.isArray(Memory.terminalManager.operations)) Memory.terminalManager.operations = [];
      if (!Array.isArray(Memory.terminalManager.bots)) Memory.terminalManager.bots = [];
      if (typeof Memory.terminalManager.lastMaintenanceTick !== "number") Memory.terminalManager.lastMaintenanceTick = null;
      if (typeof Memory.terminalManager.lastCompletedCleanupTick !== "number") Memory.terminalManager.lastCompletedCleanupTick = null;
    }
  },
  v2Enabled: function(e) {
    var r = Game.rooms[e];
    return !!(r && r.controller && r.controller.my);
  },
  releaseOpReservation: function(e) {
    if (!e) return;
    if (Array.isArray(e.reservationEntries) && e.reservationEntries.length > 0) {
      for (var r = 0; r < e.reservationEntries.length; r++) {
        var a = e.reservationEntries[r];
        if (!a || !a.roomName || !a.building || !a.program) continue;
        storageManager.unReserve(a.roomName, e.resourceType, a.building, a.program);
      }
    } else if (e.reservationProgram && e.reservationBuilding) {
      storageManager.unReserve(e.reservationRoom, e.resourceType, e.reservationBuilding, e.reservationProgram);
    }
    delete e.reservationProgram;
    delete e.reservationBuilding;
    delete e.reservationRoom;
    delete e.reservationEntries;
  },
  ensureReservationEntries: function(e) {
    if (!e.reservationEntries) e.reservationEntries = [];
    return e.reservationEntries;
  },
  addReservationEntry: function(e, r, a, t) {
    if (!e || !r || !a || !t) return;
    var o = this.ensureReservationEntries(e);
    for (var i = 0; i < o.length; i++) {
      if (o[i] && o[i].roomName === r && o[i].building === a && o[i].program === t) {
        return;
      }
    }
    o.push({
      roomName: r,
      building: a,
      program: t
    });
  },
  reserveOperationStock: function(e, r, a, t, o, i) {
    if (!e || !r || !a || !t || !i || !o) return {
      ok: false,
      reason: "Missing required parameter"
    };
    var n = storageManager.reserve(r, a, t, i, o);
    if (n.ok) {
      this.addReservationEntry(e, r, t, i);
      e.reservationProgram = i;
      e.reservationRoom = r;
      if (!e.reservationBuilding) e.reservationBuilding = t;
    }
    return n;
  },
  consumeOperationStock: function(e, r, a, t, o, i) {
    if (!e || !r || !a || !t || !i || !o) return {
      ok: false,
      consumed: 0,
      remaining: 0
    };
    return storageManager.consume(r, a, t, i, o);
  },
  observeOperationProgress: function(e) {
    if (!e || e.type !== "toTerminal") return;
    var r = typeof e.amountMoved === "number" && e.amountMoved > 0 ? e.amountMoved : 0;
    if (typeof e._lastObservedAmountMoved !== "number") {
      e._lastObservedAmountMoved = r;
      e._lastProgressTick = r > 0 ? Game.time : typeof e.created === "number" ? e.created : Game.time;
      return;
    }
    if (r !== e._lastObservedAmountMoved) {
      e._lastObservedAmountMoved = r;
      e._lastProgressTick = Game.time;
    }
  },
  isOperationStale: function(e, r) {
    if (!e || e.type !== "toTerminal" || e.status === "completed" || e.status === "failed") return false;
    this.observeOperationProgress(e);
    var a = typeof r === "number" && r > 0 ? r : LOCAL_NO_PROGRESS_TIMEOUT;
    var t = typeof e._lastProgressTick === "number" ? e._lastProgressTick : typeof e.created === "number" ? e.created : Game.time;
    return Game.time - t >= a;
  },
  shouldUseTerminalBotForOp: function(e) {
    return !!(e && e.type === "toStorage" && e.resourceType === RESOURCE_ENERGY && (e.amount || 0) >= TERMINAL_BOT_ENERGY_THRESHOLD);
  },
  shouldUseSupplierForOp: function(e) {
    if (!e) return false;
    if (e.type !== "toTerminal" && e.type !== "toStorage") return false;
    if (singleSourceRoom && typeof singleSourceRoom.isSingleSourceActive === "function" && singleSourceRoom.isSingleSourceActive(e.roomName)) {
      return false;
    }
    return !this.shouldUseTerminalBotForOp(e);
  },
  addSupplierTask: function(e, r) {
    if (!e || !r || !r.id) return;
    if (!Memory.terminalManager.supplierTasks) Memory.terminalManager.supplierTasks = {};
    if (!Memory.terminalManager.supplierTasks[e]) Memory.terminalManager.supplierTasks[e] = [];
    var a = Memory.terminalManager.supplierTasks[e];
    for (var t = 0; t < a.length; t++) {
      if (a[t] && a[t].opId === r.id) return;
    }
    a.push({
      opId: r.id,
      type: r.type,
      resourceType: r.resourceType,
      amount: r.amount,
      reservationProgram: r.reservationProgram || null
    });
  },
  getSupplierTasks: function(e) {
    return Memory.terminalManager && Memory.terminalManager.supplierTasks && Memory.terminalManager.supplierTasks[e] || [];
  },
  cleanupSupplierTasks: function() {
    if (!Memory.terminalManager || !Memory.terminalManager.supplierTasks) return;
    var e = {};
    var r = Memory.terminalManager.operations || [];
    for (var a = 0; a < r.length; a++) {
      if (r[a] && r[a].id) e[r[a].id] = true;
    }
    for (var t in Memory.terminalManager.supplierTasks) {
      var o = Memory.terminalManager.supplierTasks[t];
      if (!Array.isArray(o)) continue;
      for (var i = o.length - 1; i >= 0; i--) {
        if (!o[i] || !e[o[i].opId]) {
          o.splice(i, 1);
        }
      }
    }
  },
  run: function() {
    this.init();
    var e = Memory.terminalManager;
    var r = e.lastMaintenanceTick === null || e.lastMaintenanceTick > Game.time || Game.time - e.lastMaintenanceTick >= 50;
    var a = e.lastCompletedCleanupTick === null || e.lastCompletedCleanupTick > Game.time || Game.time - e.lastCompletedCleanupTick >= 100;
    getRoomState.init();
    if (r) {
      this.checkAndCancelStuckWaits(5e3);
      this.autoBalanceTerminalEnergy();
      e.lastMaintenanceTick = Game.time;
      memoryManager.requestSave();
    }
    this.processOperations();
    this.manageBots();
    this.cleanupSupplierTasks();
    if (a) {
      this.cleanupCompletedOperations();
      e.lastCompletedCleanupTick = Game.time;
      memoryManager.requestSave();
    }
  },
  transferStuff: function(e, r, a, t, o) {
    if (!this.validateResource(a)) {
      return "[Terminal] Invalid resource type: " + a;
    }
    if (t === "max") {
      if (a === RESOURCE_ENERGY) {
        return "[Terminal] Cannot use 'max' for energy.";
      }
      t = this.getRoomTotalAvailable(e, a);
      if (t <= 0) {
        return "[Terminal] No " + a + " available in " + e;
      }
    }
    if (!t || t <= 0) {
      return "[Terminal] Invalid amount: " + t + ". Must be positive.";
    }
    if (!Game.rooms[e] || !Game.rooms[e].controller || !Game.rooms[e].controller.my) {
      return "[Terminal] Invalid source room: " + e + ". Must be a room you own.";
    }
    var i = Game.rooms[e].terminal;
    if (!i) {
      return "[Terminal] No terminal in source room: " + e;
    }
    var n = this.getOperationTerminalAvailable({
      fromRoom: e
    }, a);
    var s = this.getTransferableStorageAvailable(e, a);
    var m = n + s;
    if (n < t) {
      console.log("[Terminal] Scheduling transfer with short terminal stock in " + e + ": have " + n + "/" + t + " " + a + ". A feeder op will stage the shortfall from storage.");
    }
    var l = Game.rooms[r];
    var u = false;
    if (l) u = !!l.terminal; else u = true;
    if (!u) {
      return "[Terminal] No terminal visible in destination room: " + r;
    }
    if (m < t) {
      return "[Terminal] Insufficient " + a + " in " + e + ": room has " + m + ", requested " + t + " (terminal: " + n + ", outside: " + s + ").";
    }
    var f = Memory.terminalManager.operations || [];
    for (var v = 0; v < f.length; v++) {
      var R = f[v];
      if (!R || R.type !== "transfer") continue;
      if (R.fromRoom !== e || R.toRoom !== r) continue;
      if (R.resourceType !== a) continue;
      if (R.status === "completed" || R.status === "failed") continue;
      var g = R.amountTransferred || 0;
      var c = Math.max(0, R.amount - g);
      if (c <= 0) continue;
      if (c + t > m) {
        return "[Terminal] Cannot merge: room has " + m + " " + a + ", existing op still needs " + c + ", new request " + t + ".";
      }
      var p = R.amount + t;
      if (R.reservationProgram && R.reservationBuilding === "terminal" && R.reservationRoom === e) {
        var M = storageManager.storageFind(e, a);
        var y = 0;
        var E = M.terminal.reservations || [];
        for (var d = 0; d < E.length; d++) {
          if (E[d].program === R.reservationProgram) {
            y = E[d].amount || 0;
            break;
          }
        }
        var T = y + t;
        var O = this.reserveOperationStock(R, e, a, "terminal", T, R.reservationProgram);
        if (!O.ok) {
          return "[Terminal] Cannot merge: failed to extend terminal reservation by " + t + " " + a + " in " + e + ": " + (O.reason || "unknown");
        }
      }
      R.amount = p;
      memoryManager.requestImmediateSave("terminalManager.mergeTransfer");
      console.log("[Terminal] Merged into existing transfer op " + R.id + ": new total " + R.amount + " " + a + " from " + e + " to " + r);
      return "[Terminal] Merged into existing transfer op " + R.id + ": new total " + R.amount + " " + a + " from " + e + " to " + r;
    }
    var S = {
      id: "transfer_" + Game.time + "_" + Math.random().toString(36).substr(2, 9),
      type: "transfer",
      fromRoom: e,
      toRoom: r,
      resourceType: a,
      amount: t,
      status: "pending",
      created: Game.time,
      amountTransferred: 0,
      accountingSource: o || null
    };
    var C = null;
    if (this.v2Enabled(e)) {
      var M = storageManager.storageFind(e, a);
      var h = M.terminal.total - M.terminal.reserved;
      var A = M.storage.total - M.storage.reserved;
      var _ = this.getTransferableStorageAvailable(e, a);
      if (h < t) {
        console.log("[Terminal] v2 reserve warning: only " + h + " free of " + t + " " + a + " in " + e + " terminal. Op will queue and wait.");
      }
      var U = "terminalManager_transfer_" + S.id;
      var N = Math.min(t, Math.max(0, h));
      if (N > 0) {
        var O = this.reserveOperationStock(S, e, a, "terminal", N, U);
        if (O.ok) {
          S.reservationProgram = U;
          S.reservationBuilding = "terminal";
          S.reservationRoom = e;
        }
      }
      var b = Math.max(0, t - N);
      if (b > 0 && singleSourceRoom.isSingleSourceActive(e)) {
        this.releaseOpReservation(S);
        return "[Terminal] Source room feeder unavailable while single-source protection is active in " + e;
      }
      if (b > 0 && _ > 0) {
        var I = Math.min(b, _);
        var Y = Math.min(I, A);
        C = {
          id: "feeder_" + Game.time + "_" + Math.random().toString(36).substr(2, 9),
          type: "toTerminal",
          roomName: e,
          resourceType: a,
          amount: I,
          amountMoved: 0,
          status: "pending",
          created: Game.time,
          feederFor: S.id,
          useSupplier: true
        };
        var k = "terminalManager_feeder_" + C.id;
        var G = this.reserveOperationStock(C, e, a, "storage", Y, k);
        if (G.ok) {
          C.reservationProgram = k;
          C.reservationBuilding = "storage";
          C.reservationRoom = e;
        } else if (Y > 0) {
          this.releaseOpReservation(S);
          return "[Terminal] Failed to reserve feeder stock in " + e;
        }
        S.feederOpId = C.id;
      } else if (b > 0 && A > 0) {
        var w = Math.min(b, A);
        var fallbackReservation = this.reserveOperationStock(S, e, a, "storage", w, U);
        if (!fallbackReservation.ok) {
          this.releaseOpReservation(S);
          return "[Terminal] Failed to reserve source stock in " + e;
        }
      }
    }
    Memory.terminalManager.operations.push(S);
    if (C) {
      Memory.terminalManager.operations.push(C);
      this.addSupplierTask(e, C);
      console.log("[Terminal] Feeder op " + C.id + " queued: stage " + C.amount + " " + a + " from storage to terminal in " + e);
    }
    memoryManager.requestImmediateSave("terminalManager.createTransfer");
    console.log("[Terminal] Transfer order created: " + t + " " + a + " from " + e + " to " + r);
    return "[Terminal] Transfer order created: " + t + " " + a + " from " + e + " to " + r;
  },
  storageToTerminal: function(e, r, a) {
    if (typeof e !== "string" || !Game.rooms[e]) {
      return "[Terminal] Invalid room: " + e;
    }
    if (!this.validateResource(r)) {
      return "[Terminal] Invalid resource type: " + r;
    }
    var t = Game.rooms[e];
    if (!t.controller || !t.controller.my) {
      return "[Terminal] Room must be owned: " + e;
    }
    var o = t.terminal;
    if (!o) {
      return "[Terminal] No terminal in " + e;
    }
    if (a === "max") {
      a = this.getRoomAvailableOutsideTerminal(e, r);
    }
    if (typeof a !== "number" || a <= 0) {
      return "[Terminal] Invalid amount: " + a + ". Must be positive.";
    }
    var i = {
      id: "local_" + Game.time + "_" + Math.random().toString(36).substr(2, 9),
      type: "toTerminal",
      roomName: e,
      resourceType: r,
      amount: a,
      amountMoved: 0,
      status: "pending",
      created: Game.time
    };
    if (this.v2Enabled(e)) {
      var n = storageManager.storageFind(e, r);
      var s = n.storage.total - n.storage.reserved;
      if (s < a) {
        console.log("[Terminal] v2 reserve warning: only " + s + " free of " + a + " " + r + " in " + e + " storage. Op will queue and wait.");
      }
      var m = Math.min(a, Math.max(0, s));
      if (m > 0) {
        var l = this.reserveOperationStock(i, e, r, "storage", m, "terminalManager_toTerm_" + i.id);
        if (l.ok) {
          i.reservationProgram = "terminalManager_toTerm_" + i.id;
          i.reservationBuilding = "storage";
          i.reservationRoom = e;
        }
      }
    }
    Memory.terminalManager.operations.push(i);
    memoryManager.requestImmediateSave("terminalManager.createToTerminal");
    if (this.shouldUseSupplierForOp(i)) {
      i.useSupplier = true;
      var u = new String("[Terminal] Local order queued for supplier: move " + a + " " + r + " to Terminal in " + e);
      u.opId = i.id;
      return u;
    }
    this.assignTerminalBot(e, "collect", r, i.id);
    var f = new String("[Terminal] Local order created: move " + a + " " + r + " to Terminal in " + e);
    f.opId = i.id;
    return f;
  },
  terminalToStorage: function(e, r, a) {
    if (typeof e !== "string" || !Game.rooms[e]) {
      return "[Terminal] Invalid room: " + e;
    }
    if (!this.validateResource(r)) {
      return "[Terminal] Invalid resource type: " + r;
    }
    var t = Game.rooms[e];
    if (!t.controller || !t.controller.my) {
      return "[Terminal] Room must be owned: " + e;
    }
    var o = t.terminal;
    if (!o) {
      return "[Terminal] No terminal in " + e;
    }
    if (a === "max") {
      a = o.store && o.store[r] ? o.store[r] : 0;
    }
    if (typeof a !== "number" || a <= 0) {
      return "[Terminal] Invalid amount: " + a + ". Must be positive.";
    }
    var i = {
      id: "local_" + Game.time + "_" + Math.random().toString(36).substr(2, 9),
      type: "toStorage",
      roomName: e,
      resourceType: r,
      amount: a,
      amountMoved: 0,
      status: "pending",
      created: Game.time
    };
    if (this.v2Enabled(e)) {
      var n = storageManager.storageFind(e, r);
      var s = n.terminal.total - n.terminal.reserved;
      if (s < a) {
        console.log("[Terminal] v2 reserve warning: only " + s + " free of " + a + " " + r + " in " + e + " terminal. Op will queue and wait.");
      }
      var m = Math.min(a, Math.max(0, s));
      if (m > 0) {
        var l = this.reserveOperationStock(i, e, r, "terminal", m, "terminalManager_toStor_" + i.id);
        if (l.ok) {
          i.reservationProgram = "terminalManager_toStor_" + i.id;
          i.reservationBuilding = "terminal";
          i.reservationRoom = e;
        }
      }
    }
    Memory.terminalManager.operations.push(i);
    memoryManager.requestImmediateSave("terminalManager.createToStorage");
    if (this.shouldUseSupplierForOp(i)) {
      i.useSupplier = true;
      this.addSupplierTask(e, i);
      console.log("[Terminal] Local order queued for supplier: move " + a + " " + r + " from Terminal to Storage in " + e);
      return "[Terminal] Local order queued for supplier: move " + a + " " + r + " from Terminal to Storage in " + e;
    }
    this.assignTerminalBot(e, "drain", r, i.id);
    console.log("[Terminal] Local order created: move " + a + " " + r + " from Terminal to Storage in " + e);
    return "[Terminal] Local order created: move " + a + " " + r + " from Terminal to Storage in " + e;
  },
  status: function() {
    var e = Memory.terminalManager.operations;
    if (e.length === 0) {
      return "[Terminal] No active operations.";
    }
    console.log("=== TERMINAL MANAGER STATUS ===");
    console.log("Active operations: " + e.length);
    for (var r = 0; r < e.length; r++) {
      var a = e[r];
      var t = "";
      if (a.type === "transfer") {
        var o = a.amountTransferred || 0;
        if (o < 0) o = 0;
        if (o > a.amount) o = a.amount;
        t = "TRANSFER: " + a.amount + " " + a.resourceType + " from " + a.fromRoom + " to " + a.toRoom + " (" + o + "/" + a.amount + " transferred)";
        if (a.feederOpId) t += " [feeder: " + a.feederOpId + "]";
      } else if (a.type === "toTerminal") {
        var i = a.amountMoved || 0;
        if (i < 0) i = 0;
        if (i > a.amount) i = a.amount;
        t = "TO TERMINAL: " + a.amount + " " + a.resourceType + " in " + a.roomName + " (" + i + "/" + a.amount + " moved)";
        if (a.feederFor) t += " [feeder for " + a.feederFor + "]";
      } else if (a.type === "toStorage") {
        var n = a.amountMoved || 0;
        if (n < 0) n = 0;
        if (n > a.amount) n = a.amount;
        t = "TO STORAGE: " + a.amount + " " + a.resourceType + " from terminal in " + a.roomName + " (" + n + "/" + a.amount + " moved)";
      } else {
        t = "[unknown op type]";
      }
      console.log("  " + a.id + ": " + t + " [" + a.status + "]");
    }
    var s = this.getAllTerminalBots();
    console.log("Active terminal bots: " + s.length);
    for (var m = 0; m < s.length; m++) {
      var l = s[m];
      var u = l.room && l.room.name ? l.room.name : l.memory.terminalRoom;
      console.log("  " + l.name + ": " + (l.memory.terminalTask || "idle") + " " + (l.memory.terminalResource || "energy") + " in " + u + (l.memory.terminalOperationId ? " (op " + l.memory.terminalOperationId + ")" : ""));
    }
    return "[Terminal] Status displayed in console.";
  },
  whyTerminal: function(e) {
    if (typeof e !== "string" || e.length === 0) {
      return "[Terminal] Provide a valid room name.";
    }
    var r = Game.rooms[e];
    if (!r) return "[Terminal] Room not visible: " + e;
    var a = r.terminal;
    if (!a) return "[Terminal] No terminal in " + e;
    var t = [];
    t.push("=== TERMINAL DEBUG " + e + " ===");
    var o = a.store && a.store[RESOURCE_ENERGY] ? a.store[RESOURCE_ENERGY] : 0;
    t.push("Terminal cooldown: " + (a.cooldown || 0));
    t.push("Terminal energy: " + o);
    var i = Memory.terminalManager && Array.isArray(Memory.terminalManager.operations) ? Memory.terminalManager.operations : [];
    var n = false;
    for (var s = 0; s < i.length; s++) {
      var m = i[s];
      if (!m) continue;
      if (m.type === "transfer" && m.fromRoom === e) {
        n = true;
        var l = m.amountTransferred || 0;
        var u = Math.max(0, m.amount - l);
        var f = a.store && a.store[m.resourceType] ? a.store[m.resourceType] : 0;
        var v = util.calcTransactionCost(u, m.fromRoom, m.toRoom);
        var R = (m.resourceType === RESOURCE_ENERGY ? u : 0) + v;
        var g = Math.max(0, u - f);
        var c = Math.max(0, R - o);
        var p = 0;
        if (typeof m._waitingSince === "number") p = Game.time - m._waitingSince; else if (typeof m.created === "number") p = m.status === "waiting" ? Game.time - m.created : 0;
        var M = "";
        if (m.status === "waiting") {
          if (a.cooldown && a.cooldown > 0) M = "terminal cooldown"; else if (g > 0) M = "waiting for payload"; else if (c > 0) M = "waiting for energy"; else if (m.error) M = m.error; else M = "unknown";
        }
        t.push("- " + m.id + " [" + m.status + "]: " + u + " " + m.resourceType + " remaining; " + "cost " + v + "; " + "terminal has " + f + " " + m.resourceType + ", " + o + " energy" + (m.status === "waiting" ? "; reason: " + M + "; waited: " + p + " ticks" : "") + (l > 0 ? "; sent so far: " + l : ""));
        t.push("  energyNeededNow: " + R + " (deficit: " + c + "), payloadDeficit: " + g);
      }
      if (m.type === "toTerminal" && m.roomName === e) {
        n = true;
        var y = m.amountMoved || 0;
        var E = Math.max(0, m.amount - y);
        var d = this.getRoomAvailableOutsideTerminal(e, m.resourceType);
        var T = a.store && a.store[m.resourceType] ? a.store[m.resourceType] : 0;
        var O = "";
        if (m.status === "waiting") {
          if (d <= 0) O = "no supply outside terminal"; else if (m.error) O = m.error; else O = "unknown";
        }
        t.push("- " + m.id + " [toTerminal " + m.status + "]: " + E + "/" + m.amount + " " + m.resourceType + " remaining; " + "outside supply: " + d + "; terminal has: " + T + (O ? "; reason: " + O : ""));
      }
      if (m.type === "toStorage" && m.roomName === e) {
        n = true;
        var S = m.amountMoved || 0;
        var C = Math.max(0, m.amount - S);
        var h = a.store && a.store[m.resourceType] ? a.store[m.resourceType] : 0;
        var A = "";
        if (m.status === "waiting") {
          if (h <= 0) A = "no payload in terminal"; else if (m.error) A = m.error; else A = "unknown";
        }
        t.push("- " + m.id + " [toStorage " + m.status + "]: " + C + "/" + m.amount + " " + m.resourceType + " remaining; " + "terminal has: " + h + (A ? "; reason: " + A : ""));
      }
    }
    if (!n) {
      t.push("No transfer operations originating from " + e + ".");
    }
    var _ = Memory.terminalManager && Array.isArray(Memory.terminalManager.bots) ? Memory.terminalManager.bots : [];
    for (var U = 0; U < _.length; U++) {
      var N = _[U];
      if (!N) continue;
      if (N.roomName !== e) continue;
      t.push("- bot request " + N.id + ": " + N.status + " " + N.task + " " + N.resourceType + (N.operationId ? " (op " + N.operationId + ")" : ""));
    }
    var b = null;
    var I = getRoomState.creepIndex();
    var Y = I && I.all ? I.all : [];
    for (var k = 0; k < Y.length; k++) {
      var G = Y[k];
      if (!G || !G.memory) continue;
      if (G.memory.role === "terminalBot" && G.memory.terminalRoom === e) {
        b = G;
        break;
      }
    }
    if (b) {
      var w = b.memory.waitingState && b.memory.waitingState.isWaiting ? "waiting since " + b.memory.waitingState.waitStartTime : "active";
      var V = b.memory.sourceId || "none";
      var P = b.memory.terminalResource || RESOURCE_ENERGY;
      t.push("- bot " + b.name + ": task " + (b.memory.terminalTask || "collect") + " " + P + "; " + w + "; source " + V);
      var L = this.getRoomAvailableOutsideTerminal(e, P);
      var B = a.store && a.store[P] ? a.store[P] : 0;
      var D = this.getResourceNeeded(e, P);
      t.push("- resource " + P + ": needed " + D + ", in terminal " + B + ", outside " + L);
    } else {
      t.push("No active terminal bot in " + e + ".");
    }
    for (var x = 0; x < t.length; x++) console.log(t[x]);
    return "[Terminal] Debug printed for " + e;
  },
  cancelOperation: function(e) {
    var r = Memory.terminalManager.operations;
    var a = -1;
    for (var t = 0; t < r.length; t++) {
      if (r[t] && r[t].id === e) {
        a = t;
        break;
      }
    }
    if (a === -1) {
      return "[Terminal] Operation not found: " + e;
    }
    if (Memory.terminalManager && Array.isArray(Memory.terminalManager.bots)) {
      for (var o = Memory.terminalManager.bots.length - 1; o >= 0; o--) {
        var i = Memory.terminalManager.bots[o];
        if (i && i.operationId === e) {
          console.log("[Terminal] Removing bot request linked to cancelled op: " + i.id);
          Memory.terminalManager.bots.splice(o, 1);
        }
      }
    }
    var n = getRoomState.creepIndex();
    var s = n && n.all ? n.all : [];
    for (var m = 0; m < s.length; m++) {
      var l = s[m];
      if (l && l.memory && l.memory.terminalOperationId === e) {
        delete l.memory.terminalOperationId;
        delete l.memory.sourceId;
        delete l.memory.terminalTask;
        delete l.memory.terminalResource;
        delete l.memory.waitingState;
        console.log("[Terminal] Cleared operation link from bot: " + l.name);
      }
    }
    if (Memory.terminalManager && Memory.terminalManager.supplierTasks) {
      for (var u in Memory.terminalManager.supplierTasks) {
        var f = Memory.terminalManager.supplierTasks[u];
        if (!Array.isArray(f)) continue;
        for (var v = f.length - 1; v >= 0; v--) {
          if (f[v] && f[v].opId === e) {
            f.splice(v, 1);
          }
        }
      }
    }
    this.releaseOpReservation(r[a]);
    var R = r[a].feederOpId || r[a].feederFor;
    r.splice(a, 1);
    if (R) {
      var g = -1;
      for (var c = 0; c < r.length; c++) {
        if (r[c] && r[c].id === R) {
          g = c;
          break;
        }
      }
      if (g >= 0) {
        if (r[g].feederOpId === e) delete r[g].feederOpId;
        if (r[g].feederFor === e) delete r[g].feederFor;
        this.releaseOpReservation(r[g]);
        if (Memory.terminalManager && Array.isArray(Memory.terminalManager.bots)) {
          for (var p = Memory.terminalManager.bots.length - 1; p >= 0; p--) {
            if (Memory.terminalManager.bots[p] && Memory.terminalManager.bots[p].operationId === R) {
              Memory.terminalManager.bots.splice(p, 1);
            }
          }
        }
        var M = getRoomState.creepIndex();
        var y = M && M.all ? M.all : [];
        for (var E = 0; E < y.length; E++) {
          var d = y[E];
          if (!d || !d.memory || d.memory.terminalOperationId !== R) continue;
          delete d.memory.terminalOperationId;
          delete d.memory.sourceId;
          delete d.memory.terminalTask;
          delete d.memory.terminalResource;
          delete d.memory.waitingState;
        }
        if (Memory.terminalManager && Memory.terminalManager.supplierTasks) {
          for (var T in Memory.terminalManager.supplierTasks) {
            var O = Memory.terminalManager.supplierTasks[T];
            if (!Array.isArray(O)) continue;
            for (var S = O.length - 1; S >= 0; S--) {
              if (O[S] && O[S].opId === R) O.splice(S, 1);
            }
          }
        }
        r.splice(g, 1);
        console.log("[Terminal] Cascade-cancelled linked op: " + R);
      }
    }
    memoryManager.requestImmediateSave("terminalManager.cancelOperation");
    console.log("[Terminal] Cancelled operation: " + e);
    return "[Terminal] Cancelled operation: " + e;
  },
  getOperationTerminalAvailable: function(e, r) {
    var a = storageManager.storageFind(e.fromRoom, r);
    if (!a || !a.terminal) return 0;
    var t = e.reservationBuilding === "terminal" && e.reservationRoom === e.fromRoom ? e.reservationProgram : null;
    var o = 0;
    var i = a.terminal.reservations || [];
    for (var n = 0; n < i.length; n++) {
      if (!t || i[n].program !== t) {
        o += i[n].amount || 0;
      }
    }
    return Math.max(0, (a.terminal.total || 0) - o);
  },
  processOperations: function() {
    var e = Memory.terminalManager.operations;
    for (var r = 0; r < e.length; r++) {
      var a = e[r];
      if (!a) continue;
      var t = a.roomName || a.fromRoom;
      if (t && roomSuspender.shouldAvoidRoomWork(t)) continue;
      if (a.type === "transfer") {
        this.processTransfer(a);
      } else if (a.type === "toTerminal") {
        this.processToTerminal(a);
      } else if (a.type === "toStorage") {
        this.processToStorage(a);
      }
    }
  },
  processTransfer: function(e) {
    var r = Game.rooms[e.fromRoom];
    if (!r) {
      e.status = "failed";
      e.error = "Source room not accessible";
      this.releaseOpReservation(e);
      return;
    }
    var a = r.terminal;
    if (!a) {
      e.status = "failed";
      e.error = "No terminal in source room";
      this.releaseOpReservation(e);
      return;
    }
    if (util.wasTerminalUsed(e.fromRoom)) return;
    var t = e.amountTransferred || 0;
    var o = e.amount - t;
    if (o <= 0) {
      if (e.status !== "completed") {
        e.status = "completed";
        console.log("[Terminal] Transfer completed: " + e.amount + " " + e.resourceType + " from " + e.fromRoom + " to " + e.toRoom);
      }
      this.releaseOpReservation(e);
      return;
    }
    if (a.cooldown && a.cooldown > 0) {
      if (e.status !== "active") e.status = "waiting";
      if (typeof e._waitingSince !== "number") e._waitingSince = Game.time;
      return;
    }
    var i = this.getOperationTerminalAvailable(e, e.resourceType);
    var n = this.getOperationTerminalAvailable(e, RESOURCE_ENERGY);
    function costFor(r) {
      return util.calcTransactionCost(r, e.fromRoom, e.toRoom);
    }
    var s = Math.min(o, i);
    if (s <= 0) {
      e.status = "waiting";
      e.error = "Waiting for resources";
      if (typeof e._waitingSince !== "number") e._waitingSince = Game.time;
      return;
    }
    function fits(r) {
      var a = costFor(r);
      var t = (e.resourceType === RESOURCE_ENERGY ? r : 0) + a;
      return n >= t;
    }
    var m = s;
    if (!fits(m)) {
      var l = 0, u = s;
      while (l < u) {
        var f = Math.floor((l + u + 1) / 2);
        if (fits(f)) l = f; else u = f - 1;
      }
      m = l;
    }
    if (m <= 0) {
      e.status = "waiting";
      e.error = "Waiting for energy";
      if (typeof e._waitingSince !== "number") e._waitingSince = Game.time;
      return;
    }
    var v = costFor(m);
    var sourceState = null;
    var destinationState = null;
    try {
      sourceState = getRoomState.get(e.fromRoom);
      destinationState = getRoomState.get(e.toRoom);
    } catch (g) {}
    if (sourceState && Array.isArray(sourceState.hostiles) && sourceState.hostiles.length > 0) {
      e.status = "waiting";
      e.error = "Transfer paused while source room has hostiles";
      if (typeof e._waitingSince !== "number") e._waitingSince = Game.time;
      return;
    }
    if (destinationState && Array.isArray(destinationState.hostiles) && destinationState.hostiles.length > 0) {
      e.status = "waiting";
      e.error = "Transfer paused while destination room has hostiles";
      if (typeof e._waitingSince !== "number") e._waitingSince = Game.time;
      return;
    }
    var destinationRoom = Game.rooms[e.toRoom];
    if (destinationRoom && destinationRoom.terminal && destinationRoom.terminal.store && typeof destinationRoom.terminal.store.getFreeCapacity === "function" && destinationRoom.terminal.store.getFreeCapacity(e.resourceType) < m) {
      e.status = "waiting";
      e.error = "Waiting for destination terminal capacity";
      if (typeof e._waitingSince !== "number") e._waitingSince = Game.time;
      return;
    }
    var R = a.send(e.resourceType, m, e.toRoom);
    if (R === OK) {
      util.markTerminalUsed(e.fromRoom);
      if (e.accountingSource) {
        var g = require("economics");
        g.record(e.accountingSource, e.fromRoom, e.resourceType, {
          energy: g.value(RESOURCE_ENERGY, v)
        });
      }
      if (e.reservationProgram) {
        this.consumeOperationStock(e, e.fromRoom, e.resourceType, "terminal", m, e.reservationProgram);
      }
      e.amountTransferred = (e.amountTransferred || 0) + m;
      if (e.amountTransferred >= e.amount) {
        e.status = "completed";
        console.log("[Terminal] Transferred " + e.amount + " " + e.resourceType + " from " + e.fromRoom + " to " + e.toRoom + " (final chunk cost: " + v + " energy)");
      } else {
        e.status = "active";
      }
      if (typeof e._waitingSince === "number") delete e._waitingSince;
      memoryManager.requestImmediateSave("terminalManager.send");
    } else {
      if (e.amountTransferred > 0) e.status = "active"; else e.status = "waiting";
      if (typeof e._waitingSince !== "number") e._waitingSince = Game.time;
    }
  },
  processToTerminal: function(e) {
    if (e.status === "completed" || e.status === "failed") {
      return;
    }
    var r = Game.rooms[e.roomName];
    if (!r || !r.controller || !r.controller.my) {
      e.status = "failed";
      e.error = "Room not accessible or not owned";
      this.releaseOpReservation(e);
      return;
    }
    var a = r.terminal;
    if (!a) {
      e.status = "failed";
      e.error = "No terminal in room";
      this.releaseOpReservation(e);
      return;
    }
    if (!e.useSupplier && this.shouldUseSupplierForOp(e)) {
      e.useSupplier = true;
      this.addSupplierTask(e.roomName, e);
    }
    if (e.useSupplier) this.addSupplierTask(e.roomName, e);
    this.observeOperationProgress(e);
    var t = 0;
    if (a.store && typeof a.store.getFreeCapacity === "function") {
      t = a.store.getFreeCapacity(e.resourceType);
    } else {
      t = 1;
    }
    if (t <= 0) {
      e.status = "waiting";
      e.error = "Terminal full";
      if (typeof e._waitingSince !== "number") e._waitingSince = Game.time;
      if (!e.useSupplier) {
        this.assignTerminalBot(e.roomName, "collect", e.resourceType, e.id);
      }
      return;
    }
    var o = e.amountMoved || 0;
    var i = e.amount - o;
    if (i <= 0) {
      if (e.status !== "completed") {
        e.status = "completed";
        console.log("[Terminal] Local toTerminal completed: " + e.amount + " " + e.resourceType + " in " + e.roomName);
      }
      this.releaseOpReservation(e);
      return;
    }
    var n = this.getRoomAvailableOutsideTerminal(e.roomName, e.resourceType, e.reservationBuilding === "storage" ? e.reservationProgram : null);
    if (n <= 0) {
      e.status = "waiting";
      e.error = "No supply outside terminal";
      if (typeof e._waitingSince !== "number") e._waitingSince = Game.time;
      if (!e.useSupplier) {
        this.assignTerminalBot(e.roomName, "collect", e.resourceType, e.id);
      }
      return;
    }
    if (!e.useSupplier) {
      this.assignTerminalBot(e.roomName, "collect", e.resourceType, e.id);
    }
    e.status = "active";
    if (typeof e._waitingSince === "number") delete e._waitingSince;
  },
  processToStorage: function(e) {
    var r = Game.rooms[e.roomName];
    if (!r || !r.controller || !r.controller.my) {
      e.status = "failed";
      e.error = "Room not accessible or not owned";
      this.releaseOpReservation(e);
      return;
    }
    var a = r.terminal;
    if (!a) {
      e.status = "failed";
      e.error = "No terminal in room";
      this.releaseOpReservation(e);
      return;
    }
    if (!e.useSupplier && this.shouldUseSupplierForOp(e)) {
      e.useSupplier = true;
      this.addSupplierTask(e.roomName, e);
    }
    if (e.autoBalance && e.resourceType === RESOURCE_ENERGY) {
      var t = Memory.terminalManager.settings && typeof Memory.terminalManager.settings.energyTargetLevel === "number" ? Memory.terminalManager.settings.energyTargetLevel : 2e4;
      var o = a.store && a.store[RESOURCE_ENERGY] ? a.store[RESOURCE_ENERGY] : 0;
      if (o <= t) {
        if (e.status !== "completed") {
          e.status = "completed";
          console.log("[Terminal] Auto-balance completed early: terminal energy in " + e.roomName + " is " + o + " (target: " + t + ")");
        }
        this.releaseOpReservation(e);
        return;
      }
    }
    var i = e.amountMoved || 0;
    var n = e.amount - i;
    if (n <= 0) {
      if (e.status !== "completed") {
        e.status = "completed";
        console.log("[Terminal] Local toStorage completed: " + e.amount + " " + e.resourceType + " in " + e.roomName);
        this.sendNotification("Local toStorage completed: " + e.amount + " " + e.resourceType + " in " + e.roomName);
      }
      this.releaseOpReservation(e);
      return;
    }
    var s = a.store && a.store[e.resourceType] ? a.store[e.resourceType] : 0;
    if (s <= 0) {
      e.status = "waiting";
      e.error = "No payload in terminal";
      if (typeof e._waitingSince !== "number") e._waitingSince = Game.time;
      if (!e.useSupplier) {
        this.assignTerminalBot(e.roomName, "drain", e.resourceType, e.id);
      }
      return;
    }
    if (!e.useSupplier) {
      this.assignTerminalBot(e.roomName, "drain", e.resourceType, e.id);
    }
    e.status = "active";
    if (typeof e._waitingSince === "number") delete e._waitingSince;
  },
  manageBots: function() {
    var e = Memory.terminalManager.bots;
    for (var r = e.length - 1; r >= 0; r--) {
      if (e[r].botName && !Game.creeps[e[r].botName]) {
        e.splice(r, 1);
      }
    }
    this.cleanupStaleRequests();
    this.processSpawnRequests();
    if (Memory.terminalManager.settings.runBotsFromManager) {
      var a = this.getAllTerminalBots();
      for (var t = 0; t < a.length; t++) this.runTerminalBot(a[t]);
    }
  },
  cleanupStaleRequests: function() {
    var e = Memory.terminalManager.bots;
    for (var r = e.length - 1; r >= 0; r--) {
      var a = e[r];
      var t = false;
      var o = this.getAllTerminalBots();
      for (var i = 0; i < o.length; i++) {
        if (o[i].memory && o[i].memory.terminalRoom === a.roomName) {
          t = true;
          break;
        }
      }
      if (t && (a.status === "requested" || a.status === "spawning")) {
        e.splice(r, 1);
        continue;
      }
      if (a.status === "requested" || a.status === "spawning") {
        var n = Game.rooms[a.roomName];
        var s = n && n.terminal ? n.terminal : null;
        if (a.task === "collect") {
          var m = this.getRoomAvailableOutsideTerminal(a.roomName, a.resourceType);
          var l = false;
          if (a.operationId) {
            var u = Memory.terminalManager && Memory.terminalManager.operations ? Memory.terminalManager.operations : [];
            for (var f = 0; f < u.length; f++) {
              var v = u[f];
              if (!v) continue;
              if (v.id === a.operationId && v.type === "toTerminal" && v.roomName === a.roomName && v.resourceType === a.resourceType) {
                l = true;
                var R = v.amountMoved || 0;
                var g = Math.max(0, v.amount - R);
                if (g <= 0 || m <= 0) {
                  e.splice(r, 1);
                }
                break;
              }
            }
          }
          if (!l) {
            var c = s && s.store && s.store[a.resourceType] ? s.store[a.resourceType] : 0;
            var p = Math.max(0, this.getResourceNeeded(a.roomName, a.resourceType) - c);
            if (p <= 0 || m <= 0) {
              e.splice(r, 1);
            }
          }
          continue;
        } else if (a.task === "drain") {
          var M = s && s.store && s.store[a.resourceType] ? s.store[a.resourceType] : 0;
          if (M <= 0) {
            e.splice(r, 1);
            continue;
          }
        }
      }
      if (a.status === "completed" && Game.time - a.created > 100) {
        e.splice(r, 1);
        continue;
      }
      if (a.status === "spawning" && a.botName && !Game.creeps[a.botName]) {
        console.log("[Terminal] Cleaning up failed spawn request: " + a.id);
        e.splice(r, 1);
        continue;
      }
      if (Game.time - a.created > 500) {
        console.log("[Terminal] Cleaning up stale request: " + a.id + " (age: " + (Game.time - a.created) + " ticks)");
        e.splice(r, 1);
        continue;
      }
      if (a.status === "spawning" && a.botName && Game.creeps[a.botName]) {
        a.status = "completed";
      }
    }
  },
  getInFlightTerminalBotCount: function(e) {
    var r = 0;
    var a = getRoomState.creepIndex();
    var t = a && a.all ? a.all : [];
    for (var o = 0; o < t.length; o++) {
      var i = t[o];
      if (!i || !i.memory) continue;
      if (i.memory.role === "terminalBot" && i.memory.terminalRoom === e) r++;
    }
    var n = Memory.terminalManager.bots || [];
    for (var s = 0; s < n.length; s++) {
      var m = n[s];
      if (m.roomName !== e) continue;
      if (m.status === "spawning" || m.status === "requested") r++;
    }
    return r;
  },
  assignTerminalBot: function(e, r, a, t) {
    var o = Game.rooms[e];
    if (singleSourceRoom.isSingleSourceActive(e)) return false;
    if (!o || !o.controller || !o.controller.my) return false;
    var i = 0;
    if (t && Memory.terminalManager && Array.isArray(Memory.terminalManager.operations)) {
      for (var n = 0; n < Memory.terminalManager.operations.length; n++) {
        var s = Memory.terminalManager.operations[n];
        if (s && s.id === t && typeof s.amount === "number") {
          i = s.amount;
          break;
        }
      }
    }
    var m = null;
    if (t && Memory.terminalManager && Array.isArray(Memory.terminalManager.operations)) {
      for (var l = 0; l < Memory.terminalManager.operations.length; l++) {
        var u = Memory.terminalManager.operations[l];
        if (u && u.id === t) {
          m = u;
          break;
        }
      }
    }
    if (r !== "drain" || a !== RESOURCE_ENERGY || !this.shouldUseTerminalBotForOp(m)) {
      return false;
    }
    var f = getRoomState.creepIndex();
    var v = f && f.all ? f.all : [];
    for (var R = 0; R < v.length; R++) {
      var g = v[R];
      if (!g || !g.memory) continue;
      if (g.memory.role === "terminalBot" && g.memory.terminalRoom === e) {
        if (g.store && g.store.getUsedCapacity() > 0) {
          return true;
        }
        g.memory.terminalTask = r;
        g.memory.terminalResource = a;
        g.memory.terminalRoom = e;
        g.memory.terminalOperationId = t;
        var c = Memory.terminalManager.operations;
        for (var p = 0; p < c.length; p++) {
          var s = c[p];
          if (s && s.id === t) {
            s.botId = g.name;
            break;
          }
        }
        return true;
      }
    }
    var M = Memory.terminalManager.bots || [];
    for (var y = 0; y < M.length; y++) {
      var E = M[y];
      if (!E) continue;
      if (E.roomName === e && (E.status === "requested" || E.status === "spawning")) {
        E.task = r;
        E.resourceType = a;
        if (i > 0) E.amount = i;
        if (t) E.operationId = t;
        return true;
      }
    }
    var d = {
      id: "bot_" + Game.time + "_" + Math.random().toString(36).substr(2, 9),
      roomName: e,
      task: r,
      resourceType: a,
      amount: i,
      status: "requested",
      created: Game.time
    };
    if (t) d.operationId = t;
    Memory.terminalManager.bots.push(d);
    console.log("[Terminal] Requested bot (assign) for " + r + " " + a + " in " + e + (t ? " (op: " + t + ")" : ""));
    return true;
  },
  processSpawnRequests: function() {
    var e = Memory.terminalManager.bots || [];
    var r = [];
    for (var a = 0; a < e.length; a++) if (e[a].status === "requested") r.push(e[a]);
    for (var t = 0; t < r.length; t++) {
      var o = r[t];
      var i = Game.rooms[o.roomName];
      if (!i) continue;
      var n = null;
      var s = Memory.terminalManager.operations || [];
      for (var m = 0; m < s.length; m++) {
        if (s[m] && s[m].id === o.operationId) {
          n = s[m];
          break;
        }
      }
      if (o.task !== "drain" || o.resourceType !== RESOURCE_ENERGY || !this.shouldUseTerminalBotForOp(n)) {
        o.status = "completed";
        continue;
      }
      var l = typeof o.amount === "number" && o.amount > 0 ? o.amount : 0;
      var u = null;
      var t = getRoomState.creepIndex();
      var f = t && t.all ? t.all : [];
      for (var v = 0; v < f.length; v++) {
        var R = f[v];
        if (R && R.memory && R.memory.role === "terminalBot" && R.memory.terminalRoom === o.roomName) {
          u = R;
          break;
        }
      }
      if (u) {
        o.status = "completed";
        continue;
      }
      var g = i.terminal;
      if (o.task === "collect") {
        var c = this.getRoomAvailableOutsideTerminal(o.roomName, o.resourceType);
        var p = g && g.store && g.store[o.resourceType] ? g.store[o.resourceType] : 0;
        var M = 0;
        var y = false;
        if (o.operationId) {
          var E = Memory.terminalManager && Memory.terminalManager.operations ? Memory.terminalManager.operations : [];
          for (var d = 0; d < E.length; d++) {
            var T = E[d];
            if (!T) continue;
            if (T.id !== o.operationId) continue;
            if (T.type === "toTerminal" && T.roomName === o.roomName && T.resourceType === o.resourceType) {
              y = true;
              var O = T.amountMoved || 0;
              var S = Math.max(0, T.amount - O);
              M = S;
              break;
            }
            if (T.type === "transfer" && T.fromRoom === o.roomName) {
              y = true;
              if (o.resourceType === RESOURCE_ENERGY) {
                var C = Math.max(0, T.amount - (T.amountTransferred || 0));
                if (C > 0) {
                  var h = util.calcTransactionCost(C, T.fromRoom, T.toRoom);
                  if (T.resourceType === RESOURCE_ENERGY) {
                    M = Math.max(0, C + h - p);
                  } else {
                    M = Math.max(0, h - p);
                  }
                } else {
                  M = 0;
                }
              } else if (o.resourceType === T.resourceType) {
                var A = Math.max(0, T.amount - (T.amountTransferred || 0));
                M = Math.max(0, A - p);
              } else {
                M = 0;
              }
              break;
            }
          }
        }
        if (!y) {
          var _ = this.getResourceNeeded(o.roomName, o.resourceType);
          M = Math.max(0, _ - p);
        }
        if (M <= 0 || c <= 0) {
          o.status = "completed";
          continue;
        }
      } else if (o.task === "drain") {
        var U = g && g.store && g.store[o.resourceType] ? g.store[o.resourceType] : 0;
        if (U <= 0) {
          o.status = "completed";
          continue;
        }
      }
      var N = 1;
      var b = this.getInFlightTerminalBotCount(o.roomName);
      if (b > N) {
        continue;
      }
      var I = getRoomState.get(o.roomName);
      if (!I) continue;
      var Y = I.structuresByType || {};
      var k = Y[STRUCTURE_SPAWN] || [];
      var G = [];
      for (var w = 0; w < k.length; w++) {
        var V = k[w];
        if (V.my && !V.spawning) G.push(V);
      }
      var P = G.length > 0 ? G[0] : null;
      if (!P) continue;
      var L = this.getCreepBody("supplier", P.room.energyAvailable);
      if (!L) continue;
      var B = this.bodyCost(L);
      if (B > P.room.energyAvailable) continue;
      var D = "TerminalBot_" + o.roomName + "_" + Game.time;
      var x = {
        role: "terminalBot",
        terminalTask: o.task,
        terminalRoom: o.roomName,
        terminalResource: o.resourceType,
        terminalRequestId: o.id
      };
      if (o.operationId) x.terminalOperationId = o.operationId;
      var F = spawnManager.spawnCustomCreep(P, L, D, x);
      if (F === OK) {
        o.status = "spawning";
        o.botName = D;
        var q = Memory.terminalManager.operations;
        if (o.operationId) {
          for (var H = 0; H < q.length; H++) {
            if (q[H].id === o.operationId) {
              q[H].botId = D;
              console.log("[Terminal] Linked bot " + D + " to operation " + q[H].id);
              break;
            }
          }
        } else {
          for (var K = 0; K < q.length; K++) {
            var W = q[K];
            var Z = W.roomName === o.roomName || W.fromRoom === o.roomName;
            var X = W.resourceType === o.resourceType;
            var z = W.status === "waiting" || W.status === "pending" || W.status === "active" || W.status === "dealing";
            if (Z && X && !W.botId && z) {
              W.botId = D;
              console.log("[Terminal] Linked bot " + D + " to operation " + W.id);
              break;
            }
          }
        }
        console.log("[Terminal] Spawning terminal bot: " + D + " for " + o.task + " " + o.resourceType);
      }
    }
  },
  runTerminalBot: function(e) {
    var r = e.memory.terminalRoom || (e.room && e.room.name ? e.room.name : null);
    if (!r) {
      e.say("no room");
      return;
    }
    if (!e.memory.terminalRoom) {
      e.memory.terminalRoom = r;
    }
    var a = Game.rooms[r];
    if (!a) {
      e.moveTo(new RoomPosition(25, 25, r), {
        reusePath: 20
      });
      e.say("home");
      return;
    }
    var t = a.terminal;
    if (!t) {
      e.say("no term");
      return;
    }
    if (e.memory.role !== "terminalBot") {
      e.memory.role = "terminalBot";
    }
    var o = e.memory.terminalTask || "collect";
    var i = e.memory.terminalResource || RESOURCE_ENERGY;
    switch (o) {
     case "drain":
      this.runDrainBot(e, a.name, i);
      break;
     case "collect":
     default:
      this.runCollectBot(e, a.name, i);
      break;
    }
  },
  findNextNeededResourceForRoom: function(e) {
    var r = Game.rooms[e];
    var a = r && r.terminal ? r.terminal : null;
    if (!a) return null;
    var t = null;
    var o = 0;
    var i = 0;
    var n = Memory.terminalManager && Memory.terminalManager.operations ? Memory.terminalManager.operations : [];
    for (var s = 0; s < n.length; s++) {
      var m = n[s];
      if (!m) continue;
      if (m.status === "completed" || m.status === "failed") continue;
      if (m.type === "transfer" && m.fromRoom === e) {
        var l = Math.max(0, m.amount - (m.amountTransferred || 0));
        if (l <= 0) continue;
        if (m.resourceType === RESOURCE_ENERGY) {
          var u = util.calcTransactionCost(l, m.fromRoom, m.toRoom);
          var f = l + u;
          var v = a.store && a.store[RESOURCE_ENERGY] ? a.store[RESOURCE_ENERGY] : 0;
          var R = Math.max(0, f - v);
          if (R > 0) i += R;
        } else {
          var g = a.store && a.store[m.resourceType] ? a.store[m.resourceType] : 0;
          var c = Math.max(0, l - g);
          if (c > o) {
            o = c;
            t = m.resourceType;
          }
          var p = util.calcTransactionCost(l, m.fromRoom, m.toRoom);
          var M = a.store && a.store[RESOURCE_ENERGY] ? a.store[RESOURCE_ENERGY] : 0;
          var y = Math.max(0, p - M);
          if (y > 0) i += y;
        }
      }
      if (m.type === "toTerminal" && m.roomName === e) {
        var E = m.amountMoved || 0;
        var d = Math.max(0, m.amount - E);
        if (d > o) {
          o = d;
          t = m.resourceType;
        }
      }
    }
    if (t) return t;
    if (i > 0) return RESOURCE_ENERGY;
    return null;
  },
  idleNearController: function(e, r) {
    var a = r.controller;
    if (!a) return false;
    if (e.pos.getRangeTo(a) <= 2) {
      var t = false;
      var o = e.pos.lookFor(LOOK_STRUCTURES);
      for (var i = 0; i < o.length; i++) {
        if (o[i].structureType === STRUCTURE_ROAD) {
          t = true;
          break;
        }
      }
      if (!t) {
        e.memory.idlePos = {
          x: e.pos.x,
          y: e.pos.y,
          room: r.name
        };
        return true;
      }
    }
    if (e.memory.idlePos && e.memory.idlePos.room === r.name) {
      if (e.pos.x === e.memory.idlePos.x && e.pos.y === e.memory.idlePos.y && r.name === e.memory.idlePos.room) {
        return true;
      } else {
        var n = r.getPositionAt(e.memory.idlePos.x, e.memory.idlePos.y);
        if (n) {
          e.moveTo(n, {
            reusePath: 30,
            visualizePathStyle: {
              stroke: "#8888ff"
            }
          });
          return true;
        }
        delete e.memory.idlePos;
      }
    }
    var s = this.findIdleSpotNearController(r, e);
    if (s) {
      e.memory.idlePos = {
        x: s.x,
        y: s.y,
        room: r.name
      };
      if (!(e.pos.x === s.x && e.pos.y === s.y && r.name === s.roomName)) {
        e.moveTo(s, {
          reusePath: 30,
          visualizePathStyle: {
            stroke: "#8888ff"
          }
        });
      }
      return true;
    }
    return false;
  },
  findIdleSpotNearController: function(e, r) {
    var a = e.controller;
    if (!a) return null;
    var t = [];
    var o = [];
    var i = a.pos.x;
    var n = a.pos.y;
    for (var s = -2; s <= 2; s++) {
      for (var m = -2; m <= 2; m++) {
        var l = i + s;
        var u = n + m;
        if (l < 1 || l > 48 || u < 1 || u > 48) continue;
        if (s * s + m * m > 4) continue;
        var f = e.getPositionAt(l, u);
        if (!f) continue;
        var v = f.lookFor(LOOK_CREEPS);
        if (v && v.length > 0) continue;
        var R = e.getTerrain().get(l, u);
        if (R === TERRAIN_MASK_WALL) continue;
        var g = false;
        var c = f.lookFor(LOOK_STRUCTURES);
        var p = false;
        for (var M = 0; M < c.length; M++) {
          var y = c[M].structureType;
          if (y === STRUCTURE_ROAD) {
            g = true;
            continue;
          }
          if (y === STRUCTURE_CONTAINER) continue;
          if (y === STRUCTURE_RAMPART) {
            var E = c[M];
            if (E.my || E.isPublic) continue;
            p = true;
            break;
          }
          p = true;
          break;
        }
        if (p) continue;
        if (g) o.push(f); else t.push(f);
      }
    }
    function pickClosest(e) {
      if (e.length === 0) return null;
      var a = e[0];
      var t = r.pos.getRangeTo(a);
      for (var o = 1; o < e.length; o++) {
        var i = r.pos.getRangeTo(e[o]);
        if (i < t) {
          a = e[o];
          t = i;
        }
      }
      return a;
    }
    var d = pickClosest(t);
    if (d) return d;
    return pickClosest(o);
  },
  runCollectBot: function(e, r, a) {
    var t = Game.rooms[r];
    if (!t) {
      e.moveTo(new RoomPosition(25, 25, r), {
        reusePath: 20
      });
      e.say("home");
      return;
    }
    var o = t.terminal;
    if (!o) {
      e.say("no term");
      return;
    }
    if (!e.memory.waitingState) {
      e.memory.waitingState = {
        isWaiting: false,
        lastResourceCheck: 0,
        waitStartTime: 0
      };
    }
    var i = e.store.getUsedCapacity();
    if (i > 0) {
      if (e.pos.isNearTo(o)) {
        for (var n in e.store) {
          var s = e.store[n] || 0;
          if (s > 0) {
            var m = n;
            var l = s;
            var u = e.transfer(o, m);
            if (u === OK) {
              var f = e.memory.terminalOperationId;
              var v = Memory.terminalManager && Memory.terminalManager.operations ? Memory.terminalManager.operations : [];
              var R = require("marketSell");
              var g = R && typeof R.getRequests === "function" ? R.getRequests() : [];
              var c = false;
              if (f) {
                for (var p = 0; p < v.length; p++) {
                  var M = v[p];
                  if (!M || M.id !== f) continue;
                  if (M.type === "toTerminal" && M.roomName === r && M.resourceType === m) {
                    if (typeof M.amountMoved !== "number") M.amountMoved = 0;
                    M.amountMoved += l;
                    if (M.reservationProgram) {
                      this.reserveOperationStock(M, r, m, "terminal", M.amountMoved, M.reservationProgram);
                    }
                    if (g.length > 0) {
                      for (var y = 0; y < g.length; y++) {
                        var E = g[y];
                        if (!E || E.tmOpId !== M.id || E.roomName !== r || E.resourceType !== m) continue;
                        if (M.reservationProgram) {
                          storageManager.transfer(r, m, "terminal", M.reservationProgram, "marketSell", l);
                        }
                        break;
                      }
                    }
                    c = true;
                  } else if (M.type === "transfer" && M.fromRoom === r && M.resourceType === m && M.reservationProgram) {
                    var d = Math.max(0, M.amount - (M.amountTransferred || 0));
                    if (d > 0) {
                      this.reserveOperationStock(M, r, m, "terminal", d, M.reservationProgram);
                    }
                  }
                  break;
                }
              }
              if (!c) {
                for (var T = 0; T < v.length; T++) {
                  var O = v[T];
                  if (!O) continue;
                  if (O.type === "toTerminal" && O.roomName === r && O.resourceType === m && O.status !== "completed" && O.status !== "failed") {
                    if (typeof O.amountMoved !== "number") O.amountMoved = 0;
                    O.amountMoved += l;
                    if (O.reservationProgram) {
                      this.reserveOperationStock(O, r, m, "terminal", O.amountMoved, O.reservationProgram);
                    }
                    if (g.length > 0) {
                      for (var S = 0; S < g.length; S++) {
                        var C = g[S];
                        if (!C || C.tmOpId !== O.id || C.roomName !== r || C.resourceType !== m) continue;
                        if (O.reservationProgram) {
                          storageManager.transfer(r, m, "terminal", O.reservationProgram, "marketSell", l);
                        }
                        break;
                      }
                    }
                    break;
                  }
                }
              }
            }
            break;
          }
        }
      } else {
        e.moveTo(o, {
          reusePath: 10,
          visualizePathStyle: {
            stroke: "#00ff00"
          }
        });
      }
      return;
    }
    var h = e.memory.terminalOperationId;
    var A = null;
    if (h) {
      var _ = Memory.terminalManager && Memory.terminalManager.operations ? Memory.terminalManager.operations : [];
      for (var U = 0; U < _.length; U++) {
        var N = _[U];
        if (!N) continue;
        if (N.id === h && N.type === "toTerminal" && N.roomName === r && N.resourceType === a) {
          var b = N.amountMoved || 0;
          A = Math.max(0, N.amount - b);
          break;
        }
      }
    }
    var I = A !== null ? A : this.getResourceNeeded(r, a);
    var Y = 0;
    if (A === null) {
      Y = o.store && o.store[a] ? o.store[a] : 0;
    }
    var k = A !== null ? A : Math.max(0, I - Y);
    if (k <= 0) {
      var G = this.findNextNeededResourceForRoom(r);
      if (G) {
        if (e.memory.terminalResource !== G) {
          e.memory.terminalResource = G;
          delete e.memory.sourceId;
          e.say(G === RESOURCE_ENERGY ? "E" : G);
        }
      } else {
        if (!this.idleNearController(e, t)) {
          var w = this.getWaitingSpot(t);
          if (w && !e.pos.isEqualTo(w)) {
            e.moveTo(w, {
              reusePath: 20
            });
          }
        }
        if (Game.time % 10 === 0) e.say("Idle");
        return;
      }
    }
    a = e.memory.terminalResource || a;
    var V = null;
    if (h) {
      var P = Memory.terminalManager && Memory.terminalManager.operations ? Memory.terminalManager.operations : [];
      for (var L = 0; L < P.length; L++) {
        if (P[L] && P[L].id === h) {
          V = P[L];
          break;
        }
      }
    }
    var B = null;
    if (e.memory.sourceId) {
      B = Game.getObjectById(e.memory.sourceId);
      if (!B) delete e.memory.sourceId;
    }
    var D = Game.time - e.memory.waitingState.lastResourceCheck >= 10 || !B;
    if (D) {
      e.memory.waitingState.lastResourceCheck = Game.time;
      var x = null;
      if (V && V.reservationProgram) {
        var F = storageManager.storageFind(t.name, a);
        var q = [ {
          structure: t.storage,
          bucket: F.storage
        }, {
          structure: t.terminal,
          bucket: F.terminal
        } ];
        for (var H = 0; H < q.length; H++) {
          var K = q[H];
          if (!K.structure || !K.bucket || !Array.isArray(K.bucket.reservations)) continue;
          for (var W = 0; W < K.bucket.reservations.length; W++) {
            var Z = K.bucket.reservations[W];
            if (Z && Z.program === V.reservationProgram && Z.amount > 0) {
              x = K.structure;
              break;
            }
          }
          if (x) break;
        }
      }
      if (x) {
        e.memory.sourceId = x.id;
        B = x;
        e.memory.waitingState.isWaiting = false;
      } else {
        var X = this.findResourceSources(t, a);
        if (X.length > 0) {
          var z = X[0];
          e.memory.sourceId = z.structure.id;
          B = z.structure;
          e.memory.waitingState.isWaiting = false;
        } else {
          if (!e.memory.waitingState.isWaiting) {
            e.memory.waitingState.isWaiting = true;
            e.memory.waitingState.waitStartTime = Game.time;
          }
        }
      }
    }
    if (B) {
      if (e.pos.isNearTo(B)) {
        var j = 0;
        var Q = null;
        if (h) {
          var J = Memory.terminalManager && Memory.terminalManager.operations ? Memory.terminalManager.operations : [];
          for (var $ = 0; $ < J.length; $++) {
            var ee = J[$];
            if (!ee) continue;
            if (ee.id === h && ee.type === "toTerminal" && ee.roomName === r && ee.resourceType === a) {
              var re = ee.amountMoved || 0;
              Q = Math.max(0, ee.amount - re);
              break;
            }
          }
        }
        if (Q !== null) {
          j = Q;
        } else {
          var ae = this.getResourceNeeded(r, a);
          var te = o.store && o.store[a] ? o.store[a] : 0;
          j = Math.max(0, ae - te);
        }
        var oe = 0;
        if (o.store && typeof o.store.getFreeCapacity === "function") {
          oe = o.store.getFreeCapacity(a);
        } else {
          oe = j;
        }
        var ie = B.store && (B.store[a] || 0) || 0;
        var ne = Math.min(e.store.getFreeCapacity(), ie, j, oe);
        if (ne > 0) {
          var n = e.withdraw(B, a, ne);
          if (n !== OK && n !== ERR_FULL && n !== ERR_NOT_ENOUGH_RESOURCES) {
            delete e.memory.sourceId;
          } else if (n === OK) {
            var se = null;
            if (h) {
              var me = Memory.terminalManager && Memory.terminalManager.operations ? Memory.terminalManager.operations : [];
              for (var le = 0; le < me.length; le++) {
                if (me[le] && me[le].id === h) {
                  se = me[le];
                  break;
                }
              }
            }
            if (se && se.reservationProgram) {
              var ue = B.structureType === STRUCTURE_STORAGE ? "storage" : B.structureType === STRUCTURE_TERMINAL ? "terminal" : null;
              if (ue) {
                this.consumeOperationStock(se, r, a, ue, ne, se.reservationProgram);
              }
            }
          }
        } else {
          delete e.memory.sourceId;
        }
      } else {
        e.moveTo(B, {
          reusePath: 10,
          visualizePathStyle: {
            stroke: "#ffaa00"
          }
        });
        e.say("get");
      }
    } else {
      if (!this.idleNearController(e, t)) {
        var fe = this.getWaitingSpot(t);
        if (fe && !e.pos.isEqualTo(fe)) {
          e.moveTo(fe, {
            reusePath: 20
          });
        }
      }
      if (Game.time % 10 === 0) e.say("wait");
    }
  },
  runDrainBot: function(e, r, a) {
    var t = Game.rooms[r];
    if (!t) {
      e.moveTo(new RoomPosition(25, 25, r), {
        reusePath: 20
      });
      e.say("home");
      return;
    }
    var o = t.terminal;
    if (!o) {
      e.say("no term");
      return;
    }
    if (!e.memory.waitingState) {
      e.memory.waitingState = {
        isWaiting: false,
        lastResourceCheck: 0,
        waitStartTime: 0
      };
    }
    var i = this.findStorageTarget(t, a);
    var n = e.store.getUsedCapacity();
    if (n > 0) {
      if (!i) {
        if (!this.idleNearController(e, t)) {
          var s = this.getWaitingSpot(t);
          if (s && !e.pos.isEqualTo(s)) e.moveTo(s, {
            reusePath: 20
          });
        }
        if (Game.time % 10 === 0) e.say("no tgt");
        return;
      }
      if (e.pos.isNearTo(i)) {
        var m = false;
        var l = [];
        for (var u in e.store) l.push(u);
        for (var f = 0; f < l.length; f++) {
          if (l[f] === a) {
            var v = l[0];
            l[0] = l[f];
            l[f] = v;
            break;
          }
        }
        for (var R = 0; R < l.length; R++) {
          var g = l[R];
          var c = e.store[g] || 0;
          if (c <= 0) continue;
          var p = c;
          var M = e.transfer(i, g);
          if (M === OK) {
            if (g === a) {
              var y = e.memory.terminalOperationId;
              var E = Memory.terminalManager && Memory.terminalManager.operations ? Memory.terminalManager.operations : [];
              var d = false;
              if (y) {
                for (var T = 0; T < E.length; T++) {
                  var O = E[T];
                  if (!O || O.id !== y) continue;
                  if (O.type === "toStorage" && O.roomName === r && O.resourceType === g) {
                    if (typeof O.amountMoved !== "number") O.amountMoved = 0;
                    O.amountMoved += p;
                    if (O.reservationProgram) {
                      this.reserveOperationStock(O, r, g, "storage", O.amountMoved, O.reservationProgram);
                    }
                    d = true;
                  }
                  break;
                }
              }
              if (!d) {
                for (var S = 0; S < E.length; S++) {
                  var C = E[S];
                  if (!C) continue;
                  if (C.type === "toStorage" && C.roomName === r && C.resourceType === g && C.status !== "completed" && C.status !== "failed") {
                    if (typeof C.amountMoved !== "number") C.amountMoved = 0;
                    C.amountMoved += p;
                    if (C.reservationProgram) {
                      this.reserveOperationStock(C, r, g, "storage", C.amountMoved, C.reservationProgram);
                    }
                    break;
                  }
                }
              }
            }
            m = true;
            break;
          } else if (M === ERR_FULL) {
            i = this.findStorageTarget(t, a, true);
            if (i && !e.pos.isNearTo(i)) e.moveTo(i, {
              reusePath: 10,
              visualizePathStyle: {
                stroke: "#00aaff"
              }
            });
            break;
          } else {
            continue;
          }
        }
        if (!m) {
          e.moveTo(i, {
            reusePath: 10,
            visualizePathStyle: {
              stroke: "#00aaff"
            }
          });
        }
      } else {
        e.moveTo(i, {
          reusePath: 10,
          visualizePathStyle: {
            stroke: "#00aaff"
          }
        });
        e.say("drop");
      }
      return;
    }
    var y = e.memory.terminalOperationId;
    var h = null;
    if (y) {
      var E = Memory.terminalManager && Memory.terminalManager.operations ? Memory.terminalManager.operations : [];
      for (var A = 0; A < E.length; A++) {
        var _ = E[A];
        if (!_ || _.id !== y) continue;
        if (_.type === "toStorage" && _.roomName === r && _.resourceType === a) {
          var U = _.amountMoved || 0;
          h = Math.max(0, _.amount - U);
          break;
        }
      }
    }
    if (h === null) h = e.store.getCapacity ? e.store.getCapacity() : e.store.getFreeCapacity();
    var N = o.store && o.store[a] ? o.store[a] : 0;
    if (N <= 0 || !i) {
      if (!this.idleNearController(e, t)) {
        var b = this.getWaitingSpot(t);
        if (b && !e.pos.isEqualTo(b)) e.moveTo(b, {
          reusePath: 20
        });
      }
      if (Game.time % 10 === 0) e.say("wait");
      return;
    }
    var I = Math.min(N, e.store.getFreeCapacity(), h);
    if (a === RESOURCE_ENERGY) {
      var Y = Memory.terminalManager && Memory.terminalManager.settings && typeof Memory.terminalManager.settings.energyTargetLevel === "number" ? Memory.terminalManager.settings.energyTargetLevel : 2e4;
      var k = Math.max(0, N - Y);
      I = Math.min(I, k);
    }
    if (I <= 0) {
      if (!this.idleNearController(e, t)) {
        var b = this.getWaitingSpot(t);
        if (b && !e.pos.isEqualTo(b)) e.moveTo(b, {
          reusePath: 20
        });
      }
      if (Game.time % 10 === 0) e.say("idle");
      return;
    }
    if (e.pos.isNearTo(o)) {
      var G = e.withdraw(o, a, I);
      if (G !== OK && G !== ERR_FULL && G !== ERR_NOT_ENOUGH_RESOURCES) {
        e.say("w err");
      } else {
        if (G === OK && y) {
          var w = Memory.terminalManager && Array.isArray(Memory.terminalManager.operations) ? Memory.terminalManager.operations : [];
          for (var V = 0; V < w.length; V++) {
            var P = w[V];
            if (!P || P.id !== y) continue;
            if (P.reservationProgram) {
              this.consumeOperationStock(P, r, a, "terminal", I, P.reservationProgram);
            }
            break;
          }
        }
      }
    } else {
      e.moveTo(o, {
        reusePath: 10,
        visualizePathStyle: {
          stroke: "#ffaa00"
        }
      });
    }
  },
  findResourceSources: function(e, r) {
    var a = [];
    if (e.storage && e.storage.store && (e.storage.store[r] || 0) > 0) {
      a.push({
        structure: e.storage,
        amount: e.storage.store[r],
        type: "storage",
        priority: 1
      });
    }
    var t = getRoomState.get(e.name);
    var o = t && t.structuresByType ? t.structuresByType : {};
    var i = o[STRUCTURE_FACTORY] || [];
    for (var n = 0; n < i.length; n++) {
      var s = i[n];
      if (!s.my) continue;
      if (!s.store || !(s.store[r] || 0)) continue;
      a.push({
        structure: s,
        amount: s.store[r],
        type: "factory",
        priority: 2
      });
    }
    var m = o[STRUCTURE_CONTAINER] || [];
    for (var l = 0; l < m.length; l++) {
      var u = m[l];
      if (!u.store || !(u.store[r] || 0)) continue;
      a.push({
        structure: u,
        amount: u.store[r],
        type: "container",
        priority: 2
      });
    }
    var f = o[STRUCTURE_LAB] || [];
    for (var v = 0; v < f.length; v++) {
      var R = f[v];
      if (!R.my) continue;
      if (!R.store || !(R.store[r] || 0)) continue;
      a.push({
        structure: R,
        amount: R.store[r],
        type: "lab",
        priority: 3
      });
    }
    a.sort(function(e, r) {
      if (e.priority !== r.priority) return e.priority - r.priority;
      return r.amount - e.amount;
    });
    return a;
  },
  getWaitingSpot: function(e) {
    var r = e.getTerrain();
    var a = [ {
      x: 2,
      y: 2
    }, {
      x: 47,
      y: 2
    }, {
      x: 2,
      y: 47
    }, {
      x: 47,
      y: 47
    } ];
    for (var t = 0; t < a.length; t++) {
      var o = a[t];
      if (r.get(o.x, o.y) !== TERRAIN_MASK_WALL) {
        var i = e.getPositionAt(o.x, o.y);
        if (i) {
          var n = i.lookFor(LOOK_CREEPS);
          if (n.length === 0) {
            return i;
          }
        }
      }
    }
    return null;
  },
  cleanupCompletedOperations: function() {
    var e = Memory.terminalManager.operations;
    for (var r = e.length - 1; r >= 0; r--) {
      var a = e[r];
      var t = false;
      if ((a.type === "transfer" || a.type === "toTerminal" || a.type === "toStorage") && (a.status === "completed" || a.status === "failed") && Game.time - a.created > 1e3) {
        t = true;
      }
      if (t) {
        e.splice(r, 1);
      }
    }
  },
  broadcastEnergy: function(e, r) {
    r = r || 1e4;
    if (!e || typeof e !== "string") {
      return "[Terminal] broadcastEnergy requires a destination room name.";
    }
    var a = Game.rooms[e];
    if (a && !a.terminal) {
      return "[Terminal] No terminal visible in destination room: " + e;
    }
    var t = [];
    var o = [];
    for (var i in Game.rooms) {
      var n = Game.rooms[i];
      if (!n || !n.controller || !n.controller.my) continue;
      if (i === e) continue;
      var s = n.terminal;
      if (!s) {
        o.push(i + " (no terminal)");
        continue;
      }
      var m = s.store && s.store[RESOURCE_ENERGY] ? s.store[RESOURCE_ENERGY] : 0;
      var l = util.calcTransactionCost(r, i, e);
      var u = r + l;
      if (m < u) {
        o.push(i + " (have " + m + ", need " + u + " incl. cost " + l + ")");
        continue;
      }
      var f = this.transferStuff(i, e, RESOURCE_ENERGY, r);
      t.push(i + " -> cost " + l);
    }
    console.log("[Terminal] broadcastEnergy: queued " + t.length + " transfer(s) of " + r + " energy to " + e);
    for (var v = 0; v < t.length; v++) console.log("  [OK] " + t[v]);
    for (var R = 0; R < o.length; R++) console.log("  [SKIP] " + o[R]);
    return "[Terminal] Done. " + t.length + " queued, " + o.length + " skipped.";
  },
  isRoomBusyWithTransfer: function(e) {
    const r = Memory.terminalManager && Memory.terminalManager.operations ? Memory.terminalManager.operations : [];
    for (let a = 0; a < r.length; a++) {
      const t = r[a];
      if (t.type === "transfer" && t.status !== "completed" && t.status !== "failed" && (t.fromRoom === e || t.toRoom === e)) return true;
    }
    return false;
  },
  autoBalanceTerminalEnergy: function() {
    var e = Memory.terminalManager.settings.energyHighThreshold || 1e5;
    var r = Memory.terminalManager.settings.energyTargetLevel || 2e4;
    var a = Game.rooms;
    for (var t in a) {
      var o = a[t];
      if (!o || !o.controller || !o.controller.my) continue;
      if (roomSuspender.shouldAvoidRoomWork(t)) continue;
      var i = o.terminal;
      if (!i) continue;
      var n = i.store && i.store[RESOURCE_ENERGY] ? i.store[RESOURCE_ENERGY] : 0;
      if (n <= e) continue;
      var s = Memory.terminalManager.operations;
      var m = false;
      for (var l = 0; l < s.length; l++) {
        var u = s[l];
        if (!u) continue;
        if (u.type === "toStorage" && u.roomName === t && u.resourceType === RESOURCE_ENERGY && u.status !== "completed" && u.status !== "failed") {
          m = true;
          break;
        }
      }
      if (m) continue;
      var f = false;
      for (var v = 0; v < s.length; v++) {
        var R = s[v];
        if (!R) continue;
        if (R.type === "transfer" && R.fromRoom === t && R.resourceType === RESOURCE_ENERGY && R.status !== "completed" && R.status !== "failed") {
          f = true;
          break;
        }
      }
      if (f) continue;
      var g = n - r;
      if (g <= 0) continue;
      var c = {
        id: "autobalance_" + Game.time + "_" + Math.random().toString(36).substr(2, 9),
        type: "toStorage",
        roomName: t,
        resourceType: RESOURCE_ENERGY,
        amount: g,
        amountMoved: 0,
        status: "pending",
        created: Game.time,
        autoBalance: true
      };
      if (this.v2Enabled(t)) {
        var p = storageManager.storageFind(t, RESOURCE_ENERGY);
        var M = p.terminal.total - p.terminal.reserved;
        var y = Math.min(g, Math.max(0, M));
        if (y > 0) {
          var E = this.reserveOperationStock(c, t, RESOURCE_ENERGY, "terminal", y, "terminalManager_toStor_" + c.id);
          if (E.ok) {
            c.reservationProgram = "terminalManager_toStor_" + c.id;
            c.reservationBuilding = "terminal";
            c.reservationRoom = t;
          }
        }
      }
      Memory.terminalManager.operations.push(c);
      this.assignTerminalBot(t, "drain", RESOURCE_ENERGY, c.id);
      console.log("[Terminal] Auto-balance: draining " + g + " energy from terminal in " + t + " (have " + n + ", target " + r + ")");
    }
  },
  checkAndCancelStuckWaits: function(e) {
    if (typeof e !== "number" || e <= 0) e = 5e3;
    var r = 1e3;
    var a = Memory.terminalManager && Memory.terminalManager.operations ? Memory.terminalManager.operations : [];
    for (var t = a.length - 1; t >= 0; t--) {
      var o = a[t];
      if (!o) continue;
      if (o.type === "toTerminal" && o.status !== "completed" && o.status !== "failed") {
        this.observeOperationProgress(o);
        if (this.isOperationStale(o, LOCAL_NO_PROGRESS_TIMEOUT)) {
          var i = o.amountMoved || 0;
          console.log("[Terminal] Auto-cancelling stale local toTerminal op (no progress for " + (Game.time - o._lastProgressTick) + " ticks): " + o.id + " (" + i + "/" + o.amount + " moved)");
          this.cancelOperation(o.id);
          continue;
        }
      }
      if (o.status !== "waiting") {
        if (o._waitingSince) delete o._waitingSince;
        continue;
      }
      var n = typeof o._waitingSince === "number" ? o._waitingSince : typeof o.created === "number" ? o.created : Game.time;
      o._waitingSince = n;
      var s = Game.time - n;
      if (o.type === "toTerminal" && o.roomName) {
        var m = this.getRoomAvailableOutsideTerminal(o.roomName, o.resourceType);
        if (m <= 0 && s >= r) {
          console.log("[Terminal] Auto-cancelling local toTerminal op (no supply for " + s + " ticks): " + o.id);
          this.cancelOperation(o.id);
          continue;
        }
      } else if (o.type === "toStorage" && o.roomName) {
        var l = Game.rooms[o.roomName];
        var u = l && l.terminal ? l.terminal : null;
        var f = u && u.store && u.store[o.resourceType] ? u.store[o.resourceType] : 0;
        if (f <= 0 && s >= r) {
          console.log("[Terminal] Auto-cancelling local toStorage op (no payload for " + s + " ticks): " + o.id);
          this.cancelOperation(o.id);
          continue;
        }
      }
      if (s >= e) {
        this.cancelOperation(o.id);
      }
    }
  },
  validateResource: function(e) {
    var r = [ RESOURCE_ENERGY, RESOURCE_POWER, RESOURCE_HYDROGEN, RESOURCE_OXYGEN, RESOURCE_UTRIUM, RESOURCE_LEMERGIUM, RESOURCE_KEANIUM, RESOURCE_ZYNTHIUM, RESOURCE_CATALYST, RESOURCE_HYDROXIDE, RESOURCE_ZYNTHIUM_KEANITE, RESOURCE_UTRIUM_LEMERGITE, RESOURCE_UTRIUM_HYDRIDE, RESOURCE_UTRIUM_OXIDE, RESOURCE_KEANIUM_HYDRIDE, RESOURCE_KEANIUM_OXIDE, RESOURCE_LEMERGIUM_HYDRIDE, RESOURCE_LEMERGIUM_OXIDE, RESOURCE_ZYNTHIUM_HYDRIDE, RESOURCE_ZYNTHIUM_OXIDE, RESOURCE_GHODIUM_HYDRIDE, RESOURCE_GHODIUM_OXIDE, RESOURCE_CATALYZED_UTRIUM_ACID, RESOURCE_CATALYZED_UTRIUM_ALKALIDE, RESOURCE_CATALYZED_KEANIUM_ACID, RESOURCE_CATALYZED_KEANIUM_ALKALIDE, RESOURCE_CATALYZED_LEMERGIUM_ACID, RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE, RESOURCE_CATALYZED_ZYNTHIUM_ACID, RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE, RESOURCE_CATALYZED_GHODIUM_ACID, RESOURCE_CATALYZED_GHODIUM_ALKALIDE, RESOURCE_UTRIUM_BAR, RESOURCE_LEMERGIUM_BAR, RESOURCE_ZYNTHIUM_BAR, RESOURCE_KEANIUM_BAR, RESOURCE_GHODIUM_MELT, RESOURCE_OXIDANT, RESOURCE_REDUCTANT, RESOURCE_PURIFIER, RESOURCE_BATTERY, RESOURCE_COMPOSITE, RESOURCE_CRYSTAL, RESOURCE_LIQUID, RESOURCE_WIRE, RESOURCE_SWITCH, RESOURCE_TRANSISTOR, RESOURCE_MICROCHIP, RESOURCE_CIRCUIT, RESOURCE_DEVICE, RESOURCE_CELL, RESOURCE_PHLEGM, RESOURCE_TISSUE, RESOURCE_MUSCLE, RESOURCE_ORGANOID, RESOURCE_ORGANISM, RESOURCE_ALLOY, RESOURCE_TUBE, RESOURCE_FIXTURES, RESOURCE_FRAME, RESOURCE_HYDRAULICS, RESOURCE_MACHINE, RESOURCE_CONDENSATE, RESOURCE_CONCENTRATE, RESOURCE_EXTRACT, RESOURCE_SPIRIT, RESOURCE_EMANATION, RESOURCE_ESSENCE, RESOURCE_UTRIUM_ACID, RESOURCE_UTRIUM_ALKALIDE, RESOURCE_KEANIUM_ACID, RESOURCE_KEANIUM_ALKALIDE, RESOURCE_LEMERGIUM_ACID, RESOURCE_LEMERGIUM_ALKALIDE, RESOURCE_ZYNTHIUM_ACID, RESOURCE_ZYNTHIUM_ALKALIDE, RESOURCE_GHODIUM_ACID, RESOURCE_GHODIUM_ALKALIDE, RESOURCE_GHODIUM, RESOURCE_BIOMASS, RESOURCE_METAL, RESOURCE_MIST, RESOURCE_SILICON, RESOURCE_OPS ];
    for (var a = 0; a < r.length; a++) {
      if (r[a] === e) return true;
    }
    return false;
  },
  getAllTerminalBots: function() {
    var e = [];
    var r = getRoomState.creepIndex();
    var a = r && r.all ? r.all : [];
    for (var t = 0; t < a.length; t++) {
      var o = a[t];
      if (!o || !o.memory) continue;
      if (o.memory.role === "terminalBot" && typeof o.memory.terminalRoom === "string" && typeof o.memory.terminalTask === "string") {
        e.push(o);
      }
    }
    return e;
  },
  getResourceNeeded: function(e, r) {
    var a = 0;
    var t = Memory.terminalManager && Memory.terminalManager.operations ? Memory.terminalManager.operations : [];
    for (var o = 0; o < t.length; o++) {
      var i = t[o];
      if (!i) continue;
      if (i.status === "completed" || i.status === "failed") continue;
      if (i.type === "transfer" && i.fromRoom === e) {
        var n = Math.max(0, i.amount - (i.amountTransferred || 0));
        if (n <= 0) continue;
        if (i.resourceType === r) {
          a += n;
        }
        if (r === RESOURCE_ENERGY && n > 0) {
          var s = util.calcTransactionCost(n, i.fromRoom, i.toRoom);
          if (i.resourceType === RESOURCE_ENERGY) {
            a += n + s;
          } else {
            a += s;
          }
        }
      }
      if (i.type === "toTerminal" && i.roomName === e && i.resourceType === r) {
        var m = i.amountMoved || 0;
        var l = Math.max(0, i.amount - m);
        a += l;
      }
    }
    return a;
  },
  sendNotification: function(e) {
    if (Memory.terminalManager.settings.emailNotifications) {
      Game.notify(e, 60);
    }
    console.log("[Terminal Notification] " + e);
  },
  bodyCost: function(e) {
    return util.bodyCost(e);
  },
  getCreepBody: function(e, r) {
    var a = {
      supplier: {
        200: [ CARRY, CARRY, MOVE, MOVE ],
        300: [ CARRY, CARRY, CARRY, MOVE, MOVE, MOVE ],
        400: [ CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE ],
        600: [ CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
        800: [ CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
        1e3: [ CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
        1200: [ CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
        1500: [ CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
        1800: [ CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
        2e3: [ CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE ],
        2400: [ CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, CARRY, MOVE, MOVE, CARRY, MOVE, CARRY, MOVE, MOVE, CARRY, MOVE, MOVE, MOVE, CARRY, MOVE, MOVE, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, CARRY, MOVE ]
      }
    };
    var t = a[e] || a.supplier;
    var o = [];
    for (var i in t) o.push(Number(i));
    o.sort(function(e, r) {
      return e - r;
    });
    var n = o[0];
    for (var s = 0; s < o.length; s++) {
      var m = o[s];
      if (r >= m) n = m; else break;
    }
    return t[n];
  },
  getTransferableStorageAvailable: function(e, r, oProgram) {
    var room = Game.rooms[e];
    if (!room || !room.storage || !room.storage.store) return 0;
    var amount = room.storage.store[r] || 0;
    var reserved = 0;
    try {
      var info = storageManager.storageFind(e, r);
      var block = info && info.storage;
      reserved = block ? block.reserved || 0 : 0;
      if (oProgram && block && Array.isArray(block.reservations)) {
        for (var index = 0; index < block.reservations.length; index++) {
          var reservation = block.reservations[index];
          if (reservation && reservation.program === oProgram) reserved -= reservation.amount || 0;
        }
      }
    } catch (g) {}
    return Math.max(0, amount - reserved);
  },
  getRoomAvailableOutsideTerminal: function(e, r, oProgram) {
    var a = Game.rooms[e];
    if (!a) return 0;
    var t = 0;
    var o = a.storage;
    if (o && o.store && o.store[r]) {
      var storageReserved = 0;
      try {
        var storageInfo = storageManager.storageFind(e, r);
        storageReserved = storageInfo && storageInfo.storage ? storageInfo.storage.reserved || 0 : 0;
        if (oProgram && storageInfo && storageInfo.storage && Array.isArray(storageInfo.storage.reservations)) {
          for (var reservationIndex = 0; reservationIndex < storageInfo.storage.reservations.length; reservationIndex++) {
            var reservation = storageInfo.storage.reservations[reservationIndex];
            if (reservation && reservation.program === oProgram) storageReserved -= reservation.amount || 0;
          }
        }
      } catch (g) {}
      t += Math.max(0, (o.store[r] || 0) - storageReserved);
    }
    var i = getRoomState.get(e);
    var n = i && i.structuresByType ? i.structuresByType : {};
    var s = n[STRUCTURE_CONTAINER] || [];
    for (var m = 0; m < s.length; m++) {
      var l = s[m];
      if (l.store && (l.store[r] || 0) > 0) {
        t += l.store[r];
      }
    }
    var u = n[STRUCTURE_LAB] || [];
    for (var f = 0; f < u.length; f++) {
      var v = u[f];
      if (!v.my) continue;
      if (v.store && (v.store[r] || 0) > 0) {
        t += v.store[r];
      }
    }
    var R = n[STRUCTURE_FACTORY] || [];
    for (var g = 0; g < R.length; g++) {
      var c = R[g];
      if (!c.my) continue;
      if (c.store && (c.store[r] || 0) > 0) {
        t += c.store[r];
        break;
      }
    }
    return t;
  },
  findStorageTarget: function(e, r, a) {
    if (!a) {
      if (e.storage && e.storage.store) {
        var t = true;
        if (e.storage.store.getFreeCapacity && typeof e.storage.store.getFreeCapacity === "function") {
          t = e.storage.store.getFreeCapacity(r) > 0;
        }
        if (t) return e.storage;
      }
    }
    var o = getRoomState.get(e.name);
    var i = o && o.structuresByType ? o.structuresByType : {};
    var n = i[STRUCTURE_CONTAINER] || [];
    var s = null;
    for (var m = 0; m < n.length; m++) {
      var l = n[m];
      if (!l || !l.store) continue;
      var u = true;
      if (l.store.getFreeCapacity && typeof l.store.getFreeCapacity === "function") {
        u = l.store.getFreeCapacity(r) > 0;
      }
      if (!u) continue;
      s = l;
      break;
    }
    if (s) return s;
    if (e.storage && e.storage.store) return e.storage;
    return null;
  },
  getRoomTotalAvailable: function(e, r) {
    var a = 0;
    var t = Game.rooms[e];
    if (!t) return 0;
    if (t.storage && t.storage.store && t.storage.store[r]) {
      a += t.storage.store[r];
    }
    var o = getRoomState.get(e);
    var i = o && o.structuresByType ? o.structuresByType : {};
    var n = i[STRUCTURE_CONTAINER] || [];
    for (var s = 0; s < n.length; s++) {
      var m = n[s];
      if (m.store && m.store[r]) a += m.store[r];
    }
    var l = i[STRUCTURE_LAB] || [];
    for (var u = 0; u < l.length; u++) {
      var f = l[u];
      if (f.my && f.store && f.store[r]) a += f.store[r];
    }
    var v = i[STRUCTURE_FACTORY] || [];
    for (var R = 0; R < v.length; R++) {
      var g = v[R];
      if (g.my && g.store && g.store[r]) {
        a += g.store[r];
        break;
      }
    }
    return a;
  }
};
global.transferStuff = function(e, r, a, t) {
  return terminalManager.transferStuff(e, r, a, t);
};
global.terminalStatus = function() {
  return terminalManager.status();
};
global.whyTerminal = function(e) {
  return terminalManager.whyTerminal(e);
};
global.cancelTerminalOperation = function(e) {
  return terminalManager.cancelOperation(e);
};
global.isRoomBusy = function(e) {
  return terminalManager.isRoomBusyWithTransfer(e);
};
global.broadcastEnergy = function(e, r) {
  return terminalManager.broadcastEnergy(e, r);
};
global.storageToTerminal = function(e, r, a) {
  return terminalManager.storageToTerminal(e, r, a);
};
global.terminalToStorage = function(e, r, a) {
  return terminalManager.terminalToStorage(e, r, a);
};
module.exports = terminalManager;
