// terminalManager.js
//
// Usage Examples:
//
// Transfer 3000 energy from E1S1 to E3S3 (robust partial sends; respects cooldown and energy cost)
// transferStuff('E1S1', 'E3S3', 'energy', 3000)
//
// Check status of all transfer operations and active terminal bots
// terminalStatus()
//
// Debug why a terminal in a room is waiting / not sending
// whyTerminal('E3N46')
//
// Cancel a specific transfer operation
// cancelTerminalOperation('transfer_12345_abc123def')
//
// NEW (local, intra-room moves):
// Move 2000 XGH2O from Storage/containers/labs into the Terminal
// storageToTerminal('E1S1', RESOURCE_CATALYZED_GHODIUM_ACID, 2000)
//
// Move 5000 energy from Terminal into Storage (or a container fallback)
// terminalToStorage('E1S1', RESOURCE_ENERGY, 5000)
//
// NOTE:
// - No optional chaining used, compatible with Screeps runtime.
// - Exactly one terminal bot per room (alive + spawning + requested).
// - Terminal bot auto-switches to ENERGY when needed (single bot can finish transfers).
// - Terminal bots are reusable: they watch for new transfer operations and pick them up automatically.
// - Transfers send only what the terminal can afford, considering transaction cost and cooldown,
//   and only mark progress on OK from Terminal.send. This avoids "false completed" transfers.
// - Operations that sit in 'waiting' for >5000 ticks are auto-cancelled every 50 ticks.
// - Local move ops (toTerminal/toStorage) use the terminal bot to haul within a room.
//   Progress is tracked cumulatively (amountMoved). Bots are assigned or retasked automatically.
// - Local toTerminal moves always target the requested amount, regardless of existing terminal stock.
//   They only wait if there is no outside supply or the terminal has no free capacity.
//
// Terminal Manager (reduced scope: transfers + terminalBot management only)
// - Removed: marketBuy/marketSell and all market order maintenance.
// - Kept: transfer operations, terminal bot request/spawn/runner, utilities.
//
// Measurement system: Irrelevant for code; all in-game units.

const getRoomState = require('getRoomState'); // use room state cache instead of room.find

const terminalManager = {

    // ===== INITIALIZATION =====
    init: function() {
        if (!Memory.terminalManager) {
            Memory.terminalManager = {
                operations: [],
                bots: [],
                settings: {
                    emailNotifications: true,
                    botBodyType: 'supplier',
                    maxBotsPerRoom: 1,
                    // Set true only if you do NOT run terminalBots from your main loop by role
                    runBotsFromManager: false
                }
            };
        } else {
            if (!Memory.terminalManager.settings) Memory.terminalManager.settings = {};
            if (typeof Memory.terminalManager.settings.emailNotifications !== 'boolean') Memory.terminalManager.settings.emailNotifications = true;
            if (!Memory.terminalManager.settings.botBodyType) Memory.terminalManager.settings.botBodyType = 'supplier';
            if (typeof Memory.terminalManager.settings.maxBotsPerRoom !== 'number') Memory.terminalManager.settings.maxBotsPerRoom = 1;
            if (typeof Memory.terminalManager.settings.runBotsFromManager !== 'boolean') Memory.terminalManager.settings.runBotsFromManager = false;
            if (!Array.isArray(Memory.terminalManager.operations)) Memory.terminalManager.operations = [];
            if (!Array.isArray(Memory.terminalManager.bots)) Memory.terminalManager.bots = [];
        }
        if (this.lastLogTick === undefined) this.lastLogTick = 0;
    },

    // ===== MAIN LOOP FUNCTION =====
    run: function() {
        this.init();

        // Initialize room state cache once per tick
        getRoomState.init();

        // Auto-cancel 'waiting' ops that are stuck > 5000 ticks (runs every 50 ticks)
        if (Game.time % 50 === 0) {
            this.checkAndCancelStuckWaits(5000);
        }

        this.processOperations();
        this.manageBots();
        this.cleanupCompletedOperations();
    },

    // ===== CONSOLE COMMANDS =====
    transferStuff: function(fromRoom, toRoom, resourceType, amount) {
        if (!this.validateResource(resourceType)) {
            return '[Terminal] Invalid resource type: ' + resourceType;
        }

        if (amount === 'max') {
            if (resourceType === RESOURCE_ENERGY) {
                return '[Terminal] Cannot use \'max\' for energy.';
            }
            amount = this.getRoomTotalAvailable(fromRoom, resourceType);
            if (amount <= 0) {
                return '[Terminal] No ' + resourceType + ' available in ' + fromRoom;
            }
        }

        if (!amount || amount <= 0) {
            return '[Terminal] Invalid amount: ' + amount + '. Must be positive.';
        }

        if (!Game.rooms[fromRoom] || !Game.rooms[fromRoom].controller || !Game.rooms[fromRoom].controller.my) {
            return '[Terminal] Invalid source room: ' + fromRoom + '. Must be a room you own.';
        }

        var sourceTerminal = Game.rooms[fromRoom].terminal;
        if (!sourceTerminal) {
            return '[Terminal] No terminal in source room: ' + fromRoom;
        }

        var have = (sourceTerminal.store && sourceTerminal.store[resourceType]) ? sourceTerminal.store[resourceType] : 0;
        if (have < amount) {
            console.log('[Terminal] Scheduling transfer with short terminal stock in ' + fromRoom + ': have ' + have + '/' + amount + ' ' + resourceType + '. A bot will be requested as needed.');
        }

        var destRoom = Game.rooms[toRoom];
        var destHasTerminal = false;
        if (destRoom) destHasTerminal = !!destRoom.terminal;
        else destHasTerminal = true;

        if (!destHasTerminal) {
            return '[Terminal] No terminal visible in destination room: ' + toRoom;
        }

        var operation = {
            id: 'transfer_' + Game.time + '_' + Math.random().toString(36).substr(2, 9),
            type: 'transfer',
            fromRoom: fromRoom,
            toRoom: toRoom,
            resourceType: resourceType,
            amount: amount,
            status: 'pending',
            created: Game.time,
            amountTransferred: 0
        };

        Memory.terminalManager.operations.push(operation);

        console.log('[Terminal] Transfer order created: ' + amount + ' ' + resourceType + ' from ' + fromRoom + ' to ' + toRoom);
        return '[Terminal] Transfer order created: ' + amount + ' ' + resourceType + ' from ' + fromRoom + ' to ' + toRoom;
    },

    // NEW: Local, intra-room move: Storage/containers/labs -> Terminal
    storageToTerminal: function(roomName, resourceType, amount) {
        if (typeof roomName !== 'string' || !Game.rooms[roomName]) {
            return '[Terminal] Invalid room: ' + roomName;
        }
        if (!this.validateResource(resourceType)) {
            return '[Terminal] Invalid resource type: ' + resourceType;
        }
        var room = Game.rooms[roomName];
        if (!room.controller || !room.controller.my) {
            return '[Terminal] Room must be owned: ' + roomName;
        }
        var term = room.terminal;
        if (!term) {
            return '[Terminal] No terminal in ' + roomName;
        }

        if (amount === 'max') {
            amount = this.getRoomAvailableOutsideTerminal(roomName, resourceType);
        }

        if (typeof amount !== 'number' || amount <= 0) {
            return '[Terminal] Invalid amount: ' + amount + '. Must be positive.';
        }

        var op = {
            id: 'local_' + Game.time + '_' + Math.random().toString(36).substr(2, 9),
            type: 'toTerminal',
            roomName: roomName,
            resourceType: resourceType,
            amount: amount,
            amountMoved: 0,
            status: 'pending',
            created: Game.time
        };

        Memory.terminalManager.operations.push(op);

        // Assign or request a bot to collect the resource into terminal
        this.assignTerminalBot(roomName, 'collect', resourceType, op.id);

        console.log('[Terminal] Local order created: move ' + amount + ' ' + resourceType + ' to Terminal in ' + roomName);
        return '[Terminal] Local order created: move ' + amount + ' ' + resourceType + ' to Terminal in ' + roomName;
    },

    // NEW: Local, intra-room move: Terminal -> Storage (or container fallback)
    terminalToStorage: function(roomName, resourceType, amount) {
        if (typeof roomName !== 'string' || !Game.rooms[roomName]) {
            return '[Terminal] Invalid room: ' + roomName;
        }
        if (!this.validateResource(resourceType)) {
            return '[Terminal] Invalid resource type: ' + resourceType;
        }
        var room = Game.rooms[roomName];
        if (!room.controller || !room.controller.my) {
            return '[Terminal] Room must be owned: ' + roomName;
        }
        var term = room.terminal;
        if (!term) {
            return '[Terminal] No terminal in ' + roomName;
        }

        if (amount === 'max') {
            amount = (term.store && term.store[resourceType]) ? term.store[resourceType] : 0;
        }

        if (typeof amount !== 'number' || amount <= 0) {
            return '[Terminal] Invalid amount: ' + amount + '. Must be positive.';
        }

        var op = {
            id: 'local_' + Game.time + '_' + Math.random().toString(36).substr(2, 9),
            type: 'toStorage',
            roomName: roomName,
            resourceType: resourceType,
            amount: amount,
            amountMoved: 0,
            status: 'pending',
            created: Game.time
        };

        Memory.terminalManager.operations.push(op);

        // Assign or request a bot to drain the terminal into storage
        this.assignTerminalBot(roomName, 'drain', resourceType, op.id);

        console.log('[Terminal] Local order created: move ' + amount + ' ' + resourceType + ' from Terminal to Storage in ' + roomName);
        return '[Terminal] Local order created: move ' + amount + ' ' + resourceType + ' from Terminal to Storage in ' + roomName;
    },

    status: function() {
        var operations = Memory.terminalManager.operations;

        if (operations.length === 0) {
            return '[Terminal] No active operations.';
        }

        console.log('=== TERMINAL MANAGER STATUS ===');
        console.log('Active operations: ' + operations.length);

        for (var idx = 0; idx < operations.length; idx++) {
            var op = operations[idx];
            var statusText = '';
            if (op.type === 'transfer') {
                var tr = op.amountTransferred || 0;
                if (tr < 0) tr = 0;
                if (tr > op.amount) tr = op.amount;
                statusText = 'TRANSFER: ' + op.amount + ' ' + op.resourceType + ' from ' + op.fromRoom + ' to ' + op.toRoom + ' (' + tr + '/' + op.amount + ' transferred)';
            } else if (op.type === 'toTerminal') {
                var mv1 = op.amountMoved || 0;
                if (mv1 < 0) mv1 = 0;
                if (mv1 > op.amount) mv1 = op.amount;
                statusText = 'TO TERMINAL: ' + op.amount + ' ' + op.resourceType + ' in ' + op.roomName + ' (' + mv1 + '/' + op.amount + ' moved)';
            } else if (op.type === 'toStorage') {
                var mv2 = op.amountMoved || 0;
                if (mv2 < 0) mv2 = 0;
                if (mv2 > op.amount) mv2 = op.amount;
                statusText = 'TO STORAGE: ' + op.amount + ' ' + op.resourceType + ' from terminal in ' + op.roomName + ' (' + mv2 + '/' + op.amount + ' moved)';
            } else {
                statusText = '[unknown op type]';
            }
            console.log('  ' + op.id + ': ' + statusText + ' [' + op.status + ']');
        }

        var bots = this.getAllTerminalBots();
        console.log('Active terminal bots: ' + bots.length);
        for (var b = 0; b < bots.length; b++) {
            var bot = bots[b];
            var roomName = (bot.room && bot.room.name) ? bot.room.name : bot.memory.terminalRoom;
            console.log('  ' + bot.name + ': ' + (bot.memory.terminalTask || 'idle') + ' ' + (bot.memory.terminalResource || 'energy') + ' in ' + roomName + (bot.memory.terminalOperationId ? (' (op ' + bot.memory.terminalOperationId + ')') : ''));
        }

        return '[Terminal] Status displayed in console.';
    },

    // Detailed per-room terminal debug helper
    whyTerminal: function(roomName) {
        if (typeof roomName !== 'string' || roomName.length === 0) {
            return '[Terminal] Provide a valid room name.';
        }

        var room = Game.rooms[roomName];
        if (!room) return '[Terminal] Room not visible: ' + roomName;

        var term = room.terminal;
        if (!term) return '[Terminal] No terminal in ' + roomName;

        var lines = [];
        lines.push('=== TERMINAL DEBUG ' + roomName + ' ===');

        var termEnergy = (term.store && term.store[RESOURCE_ENERGY]) ? term.store[RESOURCE_ENERGY] : 0;
        lines.push('Terminal cooldown: ' + (term.cooldown || 0));
        lines.push('Terminal energy: ' + termEnergy);

        // Show operations relevant to this room
        var ops = (Memory.terminalManager && Array.isArray(Memory.terminalManager.operations)) ? Memory.terminalManager.operations : [];
        var foundAny = false;
        for (var i = 0; i < ops.length; i++) {
            var op = ops[i];
            if (!op) continue;

            // Inter-room transfer originating here
            if (op.type === 'transfer' && op.fromRoom === roomName) {
                foundAny = true;

                var sent = op.amountTransferred || 0;
                var remaining = Math.max(0, op.amount - sent);

                var havePayload = (term.store && term.store[op.resourceType]) ? term.store[op.resourceType] : 0;
                var cost = Game.market.calcTransactionCost(remaining, op.fromRoom, op.toRoom);
                var energyNeeded = (op.resourceType === RESOURCE_ENERGY ? remaining : 0) + cost;

                var payloadDeficit = Math.max(0, remaining - havePayload);
                var energyDeficit = Math.max(0, energyNeeded - termEnergy);

                var waitedTicks = 0;
                if (typeof op._waitingSince === 'number') waitedTicks = Game.time - op._waitingSince;
                else if (typeof op.created === 'number') waitedTicks = (op.status === 'waiting') ? (Game.time - op.created) : 0;

                var reason = '';
                if (op.status === 'waiting') {
                    if (term.cooldown && term.cooldown > 0) reason = 'terminal cooldown';
                    else if (payloadDeficit > 0) reason = 'waiting for payload';
                    else if (energyDeficit > 0) reason = 'waiting for energy';
                    else if (op.error) reason = op.error;
                    else reason = 'unknown';
                }

                lines.push('- ' + op.id + ' [' + op.status + ']: ' +
                           remaining + ' ' + op.resourceType + ' remaining; ' +
                           'cost ' + cost + '; ' +
                           'terminal has ' + havePayload + ' ' + op.resourceType + ', ' + termEnergy + ' energy' +
                           (op.status === 'waiting' ? ('; reason: ' + reason + '; waited: ' + waitedTicks + ' ticks') : '') +
                           (sent > 0 ? ('; sent so far: ' + sent) : '')
                          );

                lines.push('  energyNeededNow: ' + energyNeeded + ' (deficit: ' + energyDeficit + '), payloadDeficit: ' + payloadDeficit);
            }

            // Local: toTerminal in this room
            if (op.type === 'toTerminal' && op.roomName === roomName) {
                foundAny = true;
                var moved = op.amountMoved || 0;
                var remainingToMove = Math.max(0, op.amount - moved);
                var haveOutside = this.getRoomAvailableOutsideTerminal(roomName, op.resourceType);
                var termHave = (term.store && term.store[op.resourceType]) ? term.store[op.resourceType] : 0;

                var reason2 = '';
                if (op.status === 'waiting') {
                    if (haveOutside <= 0) reason2 = 'no supply outside terminal';
                    else if (op.error) reason2 = op.error;
                    else reason2 = 'unknown';
                }

                lines.push('- ' + op.id + ' [toTerminal ' + op.status + ']: ' +
                           remainingToMove + '/' + op.amount + ' ' + op.resourceType + ' remaining; ' +
                           'outside supply: ' + haveOutside + '; terminal has: ' + termHave +
                           (reason2 ? ('; reason: ' + reason2) : ''));
            }

            // Local: toStorage in this room
            if (op.type === 'toStorage' && op.roomName === roomName) {
                foundAny = true;
                var moved2 = op.amountMoved || 0;
                var remainingToMove2 = Math.max(0, op.amount - moved2);
                var termHave2 = (term.store && term.store[op.resourceType]) ? term.store[op.resourceType] : 0;

                var reason3 = '';
                if (op.status === 'waiting') {
                    if (termHave2 <= 0) reason3 = 'no payload in terminal';
                    else if (op.error) reason3 = op.error;
                    else reason3 = 'unknown';
                }

                lines.push('- ' + op.id + ' [toStorage ' + op.status + ']: ' +
                           remainingToMove2 + '/' + op.amount + ' ' + op.resourceType + ' remaining; ' +
                           'terminal has: ' + termHave2 +
                           (reason3 ? ('; reason: ' + reason3) : ''));
            }
        }
        if (!foundAny) {
            lines.push('No transfer operations originating from ' + roomName + '.');
        }

        // Show bot requests for this room
        var reqs = Memory.terminalManager && Array.isArray(Memory.terminalManager.bots) ? Memory.terminalManager.bots : [];
        for (var r = 0; r < reqs.length; r++) {
            var req = reqs[r];
            if (!req) continue;
            if (req.roomName !== roomName) continue;

            lines.push('- bot request ' + req.id + ': ' + req.status + ' ' + req.task + ' ' + req.resourceType + (req.operationId ? (' (op ' + req.operationId + ')') : ''));
        }

        // Show active bot status (if any)
        var bot = null;
        var creeps = Game.creeps;
        for (var name in creeps) {
            var c = creeps[name];
            if (!c || !c.memory) continue;
            if (c.memory.role === 'terminalBot' && c.memory.terminalRoom === roomName) { bot = c; break; }
        }

        if (bot) {
            var ws = (bot.memory.waitingState && bot.memory.waitingState.isWaiting) ? ('waiting since ' + bot.memory.waitingState.waitStartTime) : 'active';
            var src = bot.memory.sourceId || 'none';
            var res = bot.memory.terminalResource || RESOURCE_ENERGY;
            lines.push('- bot ' + bot.name + ': task ' + (bot.memory.terminalTask || 'collect') + ' ' + res + '; ' + ws + '; source ' + src);

            // Resource context for the bot's current target
            var outside = this.getRoomAvailableOutsideTerminal(roomName, res);
            var haveTerm = (term.store && term.store[res]) ? term.store[res] : 0;
            var need = this.getResourceNeeded(roomName, res);
            lines.push('- resource ' + res + ': needed ' + need + ', in terminal ' + haveTerm + ', outside ' + outside);
        } else {
            lines.push('No active terminal bot in ' + roomName + '.');
        }

        for (var li = 0; li < lines.length; li++) console.log(lines[li]);
        return '[Terminal] Debug printed for ' + roomName;
    },

    cancelOperation: function(operationId) {
        var operations = Memory.terminalManager.operations;
        var index = -1;
        for (var i = 0; i < operations.length; i++) {
            if (operations[i] && operations[i].id === operationId) { index = i; break; }
        }

        if (index === -1) {
            return '[Terminal] Operation not found: ' + operationId;
        }

        // Remove any pending bot requests tied to this operation
        if (Memory.terminalManager && Array.isArray(Memory.terminalManager.bots)) {
            for (var j = Memory.terminalManager.bots.length - 1; j >= 0; j--) {
                var req = Memory.terminalManager.bots[j];
                if (req && req.operationId === operationId) {
                    console.log('[Terminal] Removing bot request linked to cancelled op: ' + req.id);
                    Memory.terminalManager.bots.splice(j, 1);
                }
            }
        }

        operations.splice(index, 1);
        console.log('[Terminal] Cancelled operation: ' + operationId);
        return '[Terminal] Cancelled operation: ' + operationId;
    },

    // ===== OPERATION PROCESSING =====
    processOperations: function() {
        var operations = Memory.terminalManager.operations;

        for (var i = 0; i < operations.length; i++) {
            var operation = operations[i];
            if (!operation) continue;

            if (operation.type === 'transfer') {
                this.processTransfer(operation);
            } else if (operation.type === 'toTerminal') {
                this.processToTerminal(operation);
            } else if (operation.type === 'toStorage') {
                this.processToStorage(operation);
            }
        }
    },

    // ROBUST transfer with cost/cooldown checks and partial sends.
    processTransfer: function(operation) {
        var sourceRoom = Game.rooms[operation.fromRoom];

        if (!sourceRoom) {
            operation.status = 'failed';
            operation.error = 'Source room not accessible';
            return;
        }

        var sourceTerminal = sourceRoom.terminal;
        if (!sourceTerminal) {
            operation.status = 'failed';
            operation.error = 'No terminal in source room';
            return;
        }

        var transferredSoFar = operation.amountTransferred || 0;
        var remaining = operation.amount - transferredSoFar;

        if (remaining <= 0) {
            if (operation.status !== 'completed') {
                operation.status = 'completed';
                console.log('[Terminal] Transfer completed: ' + operation.amount + ' ' + operation.resourceType + ' from ' + operation.fromRoom + ' to ' + operation.toRoom);
                this.sendNotification('Transfer completed: ' + operation.amount + ' ' + operation.resourceType + ' from ' + operation.fromRoom + ' to ' + operation.toRoom);
            }
            return;
        }

        // Respect terminal cooldown: cannot send if > 0
        if (sourceTerminal.cooldown && sourceTerminal.cooldown > 0) {
            if (operation.status !== 'active') operation.status = 'waiting';
            if (typeof operation._waitingSince !== 'number') operation._waitingSince = Game.time;
            return;
        }

        // Current terminal stocks
        var payloadAvail = (sourceTerminal.store && sourceTerminal.store[operation.resourceType]) ? sourceTerminal.store[operation.resourceType] : 0;
        var energyAvail  = (sourceTerminal.store && sourceTerminal.store[RESOURCE_ENERGY]) ? sourceTerminal.store[RESOURCE_ENERGY] : 0;

        function costFor(x) {
            return Game.market.calcTransactionCost(x, operation.fromRoom, operation.toRoom);
        }

        // Decide maximum candidate amount based on payload in terminal
        var maxCandidate = Math.min(remaining, payloadAvail);

        // Request bots if we're short (preserves behavior)
        if (operation.resourceType === RESOURCE_ENERGY) {
            var reqCost = costFor(Math.min(remaining, payloadAvail));
            var requiredTotal = Math.min(remaining, payloadAvail) + reqCost;
            if (energyAvail < requiredTotal) {
                terminalManager.requestBot(operation.fromRoom, 'collect', RESOURCE_ENERGY, operation.id);
            }
        } else {
            if (payloadAvail < remaining) {
                terminalManager.requestBot(operation.fromRoom, 'collect', operation.resourceType, operation.id);
            }
            var costNeed = costFor(Math.min(remaining, payloadAvail));
            if (energyAvail < costNeed) {
                terminalManager.requestBot(operation.fromRoom, 'collect', RESOURCE_ENERGY, operation.id);
            }
        }

        if (maxCandidate <= 0) {
            operation.status = 'waiting';
            operation.error = 'Waiting for resources';
            if (typeof operation._waitingSince !== 'number') operation._waitingSince = Game.time;
            return;
        }

        function fits(amount) {
            var cost = costFor(amount);
            var energyNeeded = (operation.resourceType === RESOURCE_ENERGY ? amount : 0) + cost;
            return energyAvail >= energyNeeded;
        }

        var sendAmount = maxCandidate;
        if (!fits(sendAmount)) {
            // Binary search for largest affordable amount
            var low = 0, high = maxCandidate;
            while (low < high) {
                var mid = Math.floor((low + high + 1) / 2);
                if (fits(mid)) low = mid;
                else high = mid - 1;
            }
            sendAmount = low;
        }

        if (sendAmount <= 0) {
            operation.status = 'waiting';
            operation.error = 'Waiting for energy';
            if (typeof operation._waitingSince !== 'number') operation._waitingSince = Game.time;
            return;
        }

        var transferCost = costFor(sendAmount);

        var result = sourceTerminal.send(operation.resourceType, sendAmount, operation.toRoom);
        if (result === OK) {
            operation.amountTransferred = (operation.amountTransferred || 0) + sendAmount;
            if (operation.amountTransferred >= operation.amount) {
                operation.status = 'completed';
                console.log('[Terminal] Transferred ' + operation.amount + ' ' + operation.resourceType + ' from ' + operation.fromRoom + ' to ' + operation.toRoom + ' (final chunk cost: ' + transferCost + ' energy)');
                this.sendNotification('Transfer completed: ' + operation.amount + ' ' + operation.resourceType + ' from ' + operation.fromRoom + ' to ' + operation.toRoom);
            } else {
                operation.status = 'active';
            }
            if (typeof operation._waitingSince === 'number') delete operation._waitingSince;
        } else {
            if (operation.amountTransferred > 0) operation.status = 'active';
            else operation.status = 'waiting';
            if (typeof operation._waitingSince !== 'number') operation._waitingSince = Game.time;
        }
    },

    // Local: move resources into the terminal (no early complete by existing stock)
    processToTerminal: function(operation) {
        if (operation.status === 'completed' || operation.status === 'failed') {
            return;
        }
        var room = Game.rooms[operation.roomName];
        if (!room || !room.controller || !room.controller.my) {
            operation.status = 'failed';
            operation.error = 'Room not accessible or not owned';
            return;
        }
        var terminal = room.terminal;
        if (!terminal) {
            operation.status = 'failed';
            operation.error = 'No terminal in room';
            return;
        }

        // Respect terminal capacity (do not complete by stock)
        var termFree = 0;
        if (terminal.store && typeof terminal.store.getFreeCapacity === 'function') {
            termFree = terminal.store.getFreeCapacity(operation.resourceType);
        } else {
            termFree = 1; // conservative fallback
        }
        if (termFree <= 0) {
            operation.status = 'waiting';
            operation.error = 'Terminal full';
            if (typeof operation._waitingSince !== 'number') operation._waitingSince = Game.time;
            this.assignTerminalBot(operation.roomName, 'collect', operation.resourceType, operation.id);
            return;
        }

        var moved = operation.amountMoved || 0;
        var remaining = operation.amount - moved;
        if (remaining <= 0) {
            if (operation.status !== 'completed') {
                operation.status = 'completed';
                console.log('[Terminal] Local toTerminal completed: ' + operation.amount + ' ' + operation.resourceType + ' in ' + operation.roomName);
                this.sendNotification('Local toTerminal completed: ' + operation.amount + ' ' + operation.resourceType + ' in ' + operation.roomName);
            }
            return;
        }

        var outside = this.getRoomAvailableOutsideTerminal(operation.roomName, operation.resourceType);
        if (outside <= 0) {
            operation.status = 'waiting';
            operation.error = 'No supply outside terminal';
            if (typeof operation._waitingSince !== 'number') operation._waitingSince = Game.time;
            // still try to assign bot (will idle)
            this.assignTerminalBot(operation.roomName, 'collect', operation.resourceType, operation.id);
            return;
        }

        // Assign/retask a bot to collect this resource
        this.assignTerminalBot(operation.roomName, 'collect', operation.resourceType, operation.id);
        operation.status = 'active';
        if (typeof operation._waitingSince === 'number') delete operation._waitingSince;
    },

    // Local: drain resources from the terminal into storage/container
    processToStorage: function(operation) {
        var room = Game.rooms[operation.roomName];
        if (!room || !room.controller || !room.controller.my) {
            operation.status = 'failed';
            operation.error = 'Room not accessible or not owned';
            return;
        }
        var terminal = room.terminal;
        if (!terminal) {
            operation.status = 'failed';
            operation.error = 'No terminal in room';
            return;
        }

        var moved = operation.amountMoved || 0;
        var remaining = operation.amount - moved;
        if (remaining <= 0) {
            if (operation.status !== 'completed') {
                operation.status = 'completed';
                console.log('[Terminal] Local toStorage completed: ' + operation.amount + ' ' + operation.resourceType + ' in ' + operation.roomName);
                this.sendNotification('Local toStorage completed: ' + operation.amount + ' ' + operation.resourceType + ' in ' + operation.roomName);
            }
            return;
        }

        var inTerm = (terminal.store && terminal.store[operation.resourceType]) ? terminal.store[operation.resourceType] : 0;
        if (inTerm <= 0) {
            operation.status = 'waiting';
            operation.error = 'No payload in terminal';
            if (typeof operation._waitingSince !== 'number') operation._waitingSince = Game.time;
            // still try to assign bot (will idle)
            this.assignTerminalBot(operation.roomName, 'drain', operation.resourceType, operation.id);
            return;
        }

        this.assignTerminalBot(operation.roomName, 'drain', operation.resourceType, operation.id);
        operation.status = 'active';
        if (typeof operation._waitingSince === 'number') delete operation._waitingSince;
    },

    // ===== BOT MANAGEMENT =====
    manageBots: function() {
        // Remove dead bot requests pointing to dead creeps
        var bots = Memory.terminalManager.bots;
        for (var i = bots.length - 1; i >= 0; i--) {
            if (bots[i].botName && !Game.creeps[bots[i].botName]) {
                bots.splice(i, 1);
            }
        }

        this.cleanupStaleRequests();

        // NEW: proactively request bots for marketSell deficits (no energy consideration)
        this.ensureBotsForMarketSellNeeds();

        this.processSpawnRequests();

        if (Memory.terminalManager.settings.runBotsFromManager) {
            var activeBots = this.getAllTerminalBots();
            for (var b = 0; b < activeBots.length; b++) this.runBot(activeBots[b]);
        }
    },

    cleanupStaleRequests: function() {
        var requests = Memory.terminalManager.bots;

        for (var i = requests.length - 1; i >= 0; i--) {
            var request = requests[i];

            // If a live bot exists in that room, drop extra requests (hard cap 1)
            var aliveInRoom = false;
            var allBots = this.getAllTerminalBots();
            for (var ab = 0; ab < allBots.length; ab++) {
                if (allBots[ab].memory && allBots[ab].memory.terminalRoom === request.roomName) { aliveInRoom = true; break; }
            }
            if (aliveInRoom && (request.status === 'requested' || request.status === 'spawning')) {
                requests.splice(i, 1);
                continue;
            }

            // Fast remove if no longer needed OR no supply outside the terminal
            if (request.status === 'requested' || request.status === 'spawning') {
                var room = Game.rooms[request.roomName];
                var term = room && room.terminal ? room.terminal : null;

                // For collect tasks, check need/outside supply; for drain tasks, check terminal payload
                if (request.task === 'collect') {
                    var outside = this.getRoomAvailableOutsideTerminal(request.roomName, request.resourceType);

                    var handledByLocalOp = false;
                    if (request.operationId) {
                        var opsC = Memory.terminalManager && Memory.terminalManager.operations ? Memory.terminalManager.operations : [];
                        for (var kc = 0; kc < opsC.length; kc++) {
                            var oc = opsC[kc];
                            if (!oc) continue;
                            if (oc.id === request.operationId &&
                                oc.type === 'toTerminal' &&
                                oc.roomName === request.roomName &&
                                oc.resourceType === request.resourceType) {
                                handledByLocalOp = true;
                                var movedC = oc.amountMoved || 0;
                                var remC = Math.max(0, oc.amount - movedC);
                                if (remC <= 0 || outside <= 0) {
                                    requests.splice(i, 1);
                                }
                                break;
                            }
                        }
                    }
                    if (!handledByLocalOp) {
                        var have = (term && term.store && term.store[request.resourceType]) ? term.store[request.resourceType] : 0;
                        var need = Math.max(0, this.getResourceNeeded(request.roomName, request.resourceType) - have);
                        if (need <= 0 || outside <= 0) {
                            requests.splice(i, 1);
                        }
                    }
                    continue;
                } else if (request.task === 'drain') {
                    var inTerm = (term && term.store && term.store[request.resourceType]) ? term.store[request.resourceType] : 0;
                    if (inTerm <= 0) {
                        requests.splice(i, 1);
                        continue;
                    }
                }
            }

            if (request.status === 'completed' && (Game.time - request.created) > 100) {
                requests.splice(i, 1);
                continue;
            }

            if (request.status === 'spawning' && request.botName && !Game.creeps[request.botName]) {
                console.log('[Terminal] Cleaning up failed spawn request: ' + request.id);
                requests.splice(i, 1);
                continue;
            }

            if ((Game.time - request.created) > 500) {
                console.log('[Terminal] Cleaning up stale request: ' + request.id + ' (age: ' + (Game.time - request.created) + ' ticks)');
                requests.splice(i, 1);
                continue;
            }

            if (request.status === 'spawning' && request.botName && Game.creeps[request.botName]) {
                request.status = 'completed';
            }
        }
    },

    // Hard cap: exactly one bot per room, counting alive + spawning + requested
    getInFlightTerminalBotCount: function(roomName) {
        var count = 0;

        // Alive
        var creeps = Game.creeps;
        for (var name in creeps) {
            var c = creeps[name];
            if (!c || !c.memory) continue;
            if (c.memory.role === 'terminalBot' && c.memory.terminalRoom === roomName) count++;
        }

        // Spawning + requested
        var requests = Memory.terminalManager.bots || [];
        for (var i = 0; i < requests.length; i++) {
            var r = requests[i];
            if (r.roomName !== roomName) continue;
            if (r.status === 'spawning' || r.status === 'requested') count++;
        }

        return count;
    },

    // requestBot always honors automatic spawning. operationId remains for linking. (collect tasks)
    requestBot: function(roomName, task, resourceType, operationId) {
        var room = Game.rooms[roomName];
        if (!room || !room.controller || !room.controller.my) return false;

        // 1) Calculate net need and bail if nothing is needed
        var needed = this.getResourceNeeded(roomName, resourceType);
        var have = (room.terminal && room.terminal.store && room.terminal.store[resourceType]) ? room.terminal.store[resourceType] : 0;
        var netNeeded = Math.max(0, needed - have);
        if (netNeeded <= 0) {
            return false;
        }

        // 1b) Ensure there is some supply in-room (outside the terminal) to move
        var outside = this.getRoomAvailableOutsideTerminal(roomName, resourceType);
        if (outside <= 0) {
            return false;
        }

        // 2) Hard cap: exactly one per room
        var maxBots = 1;
        var inFlight = this.getInFlightTerminalBotCount(roomName);
        if (inFlight >= maxBots) {
            return false;
        }

        // 3) If any alive bot exists in the room, skip (it will pick up the job)
        var existingBot = null;
        var creeps = Game.creeps;
        for (var name in creeps) {
            var c = creeps[name];
            if (c && c.memory && c.memory.role === 'terminalBot' && c.memory.terminalRoom === roomName) { existingBot = c; break; }
        }
        if (existingBot) {
            return false;
        }

        // 4) If a request already exists for the room, skip
        var existingRequest = null;
        var reqs = Memory.terminalManager.bots || [];
        for (var i = 0; i < reqs.length; i++) {
            var r = reqs[i];
            if (r.roomName === roomName && (r.status === 'requested' || r.status === 'spawning')) { existingRequest = r; break; }
        }
        if (existingRequest) {
            return false;
        }

        var newRequest = {
            id: 'bot_' + Game.time + '_' + Math.random().toString(36).substr(2, 9),
            roomName: roomName,
            task: task,
            resourceType: resourceType,
            status: 'requested',
            created: Game.time
        };
        if (operationId) newRequest.operationId = operationId;

        Memory.terminalManager.bots.push(newRequest);
        console.log('[Terminal] Requested bot for ' + task + ' ' + resourceType + ' in ' + roomName + ' (needed: ' + netNeeded + ', outside: ' + outside + (operationId ? (', op: ' + operationId) : '') + ')');
        return true;
    },

    // NEW: Assign an existing bot if present; otherwise create/adjust a spawn request (works for collect or drain)
    assignTerminalBot: function(roomName, task, resourceType, operationId) {
        var room = Game.rooms[roomName];
        if (!room || !room.controller || !room.controller.my) return false;

        // 0) Try to retask an alive terminalBot in this room
        var creeps = Game.creeps;
        for (var name in creeps) {
            var c = creeps[name];
            if (!c || !c.memory) continue;
            if (c.memory.role === 'terminalBot' && c.memory.terminalRoom === roomName) {
                c.memory.terminalTask = task;
                c.memory.terminalResource = resourceType;
                c.memory.terminalRoom = roomName;
                c.memory.terminalOperationId = operationId;
                // Link op to this bot
                var ops = Memory.terminalManager.operations;
                for (var i = 0; i < ops.length; i++) {
                    var op = ops[i];
                    if (op && op.id === operationId) { op.botId = c.name; break; }
                }
                return true;
            }
        }

        // 1) Check existing pending request for this room; update it to our needs
        var reqs = Memory.terminalManager.bots || [];
        for (var r = 0; r < reqs.length; r++) {
            var req = reqs[r];
            if (!req) continue;
            if (req.roomName === roomName && (req.status === 'requested' || req.status === 'spawning')) {
                req.task = task;
                req.resourceType = resourceType;
                if (operationId) req.operationId = operationId;
                return true;
            }
        }

        // 2) Otherwise create a new request (hard cap and logic handled elsewhere)
        var newRequest = {
            id: 'bot_' + Game.time + '_' + Math.random().toString(36).substr(2, 9),
            roomName: roomName,
            task: task,
            resourceType: resourceType,
            status: 'requested',
            created: Game.time
        };
        if (operationId) newRequest.operationId = operationId;

        Memory.terminalManager.bots.push(newRequest);
        console.log('[Terminal] Requested bot (assign) for ' + task + ' ' + resourceType + ' in ' + roomName + (operationId ? (' (op: ' + operationId + ')') : ''));
        return true;
    },

    processSpawnRequests: function() {
        var all = Memory.terminalManager.bots || [];
        var requests = [];
        for (var i = 0; i < all.length; i++) if (all[i].status === 'requested') requests.push(all[i]);

        for (var idx = 0; idx < requests.length; idx++) {
            var request = requests[idx];
            var room = Game.rooms[request.roomName];
            if (!room) continue;

            // If an alive bot exists now, drop this request (hard cap)
            var aliveBot = null;
            var creeps = Game.creeps;
            for (var name in creeps) {
                var c = creeps[name];
                if (c && c.memory && c.memory.role === 'terminalBot' && c.memory.terminalRoom === request.roomName) { aliveBot = c; break; }
            }
            if (aliveBot) {
                request.status = 'completed';
                continue;
            }

            // Re-check viability before committing to spawn
            var terminal = room.terminal;

            if (request.task === 'collect') {
                var outsideP = this.getRoomAvailableOutsideTerminal(request.roomName, request.resourceType);

                if (request.operationId) {
                    var opsP = Memory.terminalManager && Memory.terminalManager.operations ? Memory.terminalManager.operations : [];
                    var remP = 0;
                    for (var kp = 0; kp < opsP.length; kp++) {
                        var opP = opsP[kp];
                        if (!opP) continue;
                        if (opP.id === request.operationId &&
                            opP.type === 'toTerminal' &&
                            opP.roomName === request.roomName &&
                            opP.resourceType === request.resourceType) {
                            var movedP = opP.amountMoved || 0;
                            remP = Math.max(0, opP.amount - movedP);
                            break;
                        }
                    }
                    if (remP <= 0 || outsideP <= 0) {
                        request.status = 'completed';
                        continue;
                    }
                } else {
                    var haveP = (terminal && terminal.store && terminal.store[request.resourceType]) ? terminal.store[request.resourceType] : 0;
                    var needP = Math.max(0, this.getResourceNeeded(request.roomName, request.resourceType) - haveP);
                    if (needP <= 0 || outsideP <= 0) {
                        request.status = 'completed';
                        continue;
                    }
                }
            } else if (request.task === 'drain') {
                var inTerm = (terminal && terminal.store && terminal.store[request.resourceType]) ? terminal.store[request.resourceType] : 0;
                if (inTerm <= 0) {
                    request.status = 'completed';
                    continue;
                }
            }

            // Hard cap check again
            var maxBots = 1;
            var inFlight = this.getInFlightTerminalBotCount(request.roomName);
            if (inFlight > maxBots) {
                continue;
            }

            // Find available spawn using getRoomState instead of room.find
            var state = getRoomState.get(request.roomName);
            if (!state) continue;
            var stMap = state.structuresByType || {};
            var spawnList = stMap[STRUCTURE_SPAWN] || [];
            var spawns = [];
            for (var si = 0; si < spawnList.length; si++) {
                var s = spawnList[si];
                if (s.my && !s.spawning) spawns.push(s);
            }
            var spawn = spawns.length > 0 ? spawns[0] : null;
            if (!spawn) continue;

            var body = this.getCreepBody('supplier', spawn.room.energyAvailable);
            var cost = this.bodyCost(body);
            if (cost > spawn.room.energyAvailable) continue;

            var name = 'TerminalBot_' + request.roomName + '_' + Game.time;
            var memory = {
                role: 'terminalBot',
                terminalTask: request.task,
                terminalRoom: request.roomName,
                terminalResource: request.resourceType,
                terminalRequestId: request.id
            };
            if (request.operationId) memory.terminalOperationId = request.operationId;

            var result = spawn.spawnCreep(body, name, { memory: memory });
            if (result === OK) {
                request.status = 'spawning';
                request.botName = name;

                // Link to a relevant operation if any
                var operations = Memory.terminalManager.operations;
                if (request.operationId) {
                    for (var i2 = 0; i2 < operations.length; i2++) {
                        if (operations[i2].id === request.operationId) {
                            operations[i2].botId = name;
                            console.log('[Terminal] Linked bot ' + name + ' to operation ' + operations[i2].id);
                            break;
                        }
                    }
                } else {
                    for (var j = 0; j < operations.length; j++) {
                        var op = operations[j];
                        var matchesRoom = (op.roomName === request.roomName || op.fromRoom === request.roomName);
                        var matchesRes = (op.resourceType === request.resourceType);
                        var statusOk = (op.status === 'waiting' || op.status === 'pending' || op.status === 'active' || op.status === 'dealing');
                        if (matchesRoom && matchesRes && !op.botId && statusOk) {
                            op.botId = name;
                            console.log('[Terminal] Linked bot ' + name + ' to operation ' + op.id);
                            break;
                        }
                    }
                }

                console.log('[Terminal] Spawning terminal bot: ' + name + ' for ' + request.task + ' ' + request.resourceType);
            }
        }
    },

    // SAFE BOT RUNNER WRAPPER (use this if your main loop calls runTerminalBot)
    runTerminalBot: function(creep) {
        var roomName = creep.memory.terminalRoom || (creep.room && creep.room.name ? creep.room.name : null);
        if (!roomName) {
            creep.say('no room');
            return;
        }
        if (!creep.memory.terminalRoom) {
            creep.memory.terminalRoom = roomName;
        }

        var room = Game.rooms[roomName];
        if (!room) {
            creep.moveTo(new RoomPosition(25, 25, roomName), { reusePath: 20 });
            creep.say('home');
            return;
        }

        var terminal = room.terminal;
        if (!terminal) {
            creep.say('no term');
            return;
        }

        if (creep.memory.role !== 'terminalBot') {
            creep.memory.role = 'terminalBot';
        }

        var task = creep.memory.terminalTask || 'collect';
        var resourceType = creep.memory.terminalResource || RESOURCE_ENERGY;

        switch (task) {
            case 'drain':
                this.runDrainBot(creep, room.name, resourceType);
                break;
            case 'collect':
            default:
                this.runCollectBot(creep, room.name, resourceType);
                break;
        }
    },

    runBot: function(creep) {
        this.runTerminalBot(creep);
    },

    // Returns next needed resource for the room based on active transfer operations (non-energy prioritized)
    // Extended to include marketSell gather operations (no energy considered for marketSell).
    findNextNeededResourceForRoom: function(roomName) {
        var room = Game.rooms[roomName];
        var terminal = room && room.terminal ? room.terminal : null;
        if (!terminal) return null;

        var bestResource = null;
        var bestDeficit = 0;
        var energyNeeded = 0;

        // Existing: consider transfer operations
        var ops = Memory.terminalManager && Memory.terminalManager.operations ? Memory.terminalManager.operations : [];

        for (var i = 0; i < ops.length; i++) {
            var op = ops[i];
            if (!op) continue;
            if (op.status === 'completed' || op.status === 'failed') continue;

            if (op.type === 'transfer' && op.fromRoom === roomName) {
                var remaining = Math.max(0, op.amount - (op.amountTransferred || 0));
                if (remaining <= 0) continue;

                if (op.resourceType === RESOURCE_ENERGY) {
                    // Energy consideration remains only for transfer operations
                    var costE = Game.market.calcTransactionCost(remaining, op.fromRoom, op.toRoom);
                    var required = remaining + costE;
                    var termE = (terminal.store && terminal.store[RESOURCE_ENERGY]) ? terminal.store[RESOURCE_ENERGY] : 0;
                    var deficitE = Math.max(0, required - termE);
                    if (deficitE > 0) energyNeeded += deficitE;
                } else {
                    var termHave = (terminal.store && terminal.store[op.resourceType]) ? terminal.store[op.resourceType] : 0;
                    var deficit = Math.max(0, remaining - termHave);
                    if (deficit > bestDeficit) {
                        bestDeficit = deficit;
                        bestResource = op.resourceType;
                    }
                    var cost = Game.market.calcTransactionCost(remaining, op.fromRoom, op.toRoom);
                    var termE2 = (terminal.store && terminal.store[RESOURCE_ENERGY]) ? terminal.store[RESOURCE_ENERGY] : 0;
                    var eDef = Math.max(0, cost - termE2);
                    if (eDef > 0) energyNeeded += eDef;
                }
            }

            // NEW: include local toTerminal ops as "need inside terminal"
            if (op.type === 'toTerminal' && op.roomName === roomName) {
                var moved = op.amountMoved || 0;
                var remainLocal = Math.max(0, op.amount - moved);
                if (remainLocal > bestDeficit) {
                    bestDeficit = remainLocal;
                    bestResource = op.resourceType;
                }
            }
        }

        // NEW: consider marketSell gather operations for this room (no energy)
        var msOps = (Memory.marketSell && Array.isArray(Memory.marketSell.operations)) ? Memory.marketSell.operations : [];
        for (var j = 0; j < msOps.length; j++) {
            var m = msOps[j];
            if (!m) continue;
            if (m.roomName !== roomName) continue;
            if (m.status === 'completed' || m.status === 'cancelled') continue;
            if (typeof m.expires === 'number' && Game.time > m.expires) continue;
            if (typeof m.target !== 'number' || m.target <= 0) continue;

            var have = (terminal.store && terminal.store[m.resourceType]) ? terminal.store[m.resourceType] : 0;
            var deficitMs = Math.max(0, m.target - have);
            if (deficitMs > bestDeficit) {
                bestDeficit = deficitMs;
                bestResource = m.resourceType;
            }
        }

        if (bestResource) return bestResource;
        // If nothing else, consider energy needed for transfer ops only
        if (energyNeeded > 0) return RESOURCE_ENERGY;
        return null;
    },

    // Idle helper: choose a non-road tile within range 10 of controller if possible, cache it, and park there.
    idleNearController: function(creep, room) {
        var controller = room.controller;
        if (!controller) return false;

        if (creep.pos.getRangeTo(controller) <= 10) {
            var onRoad = false;
            var structsHere = creep.pos.lookFor(LOOK_STRUCTURES);
            for (var i = 0; i < structsHere.length; i++) {
                if (structsHere[i].structureType === STRUCTURE_ROAD) { onRoad = true; break; }
            }
            if (!onRoad) {
                creep.memory.idlePos = { x: creep.pos.x, y: creep.pos.y, room: room.name };
                return true;
            }
        }

        if (creep.memory.idlePos && creep.memory.idlePos.room === room.name) {
            if (creep.pos.x === creep.memory.idlePos.x && creep.pos.y === creep.memory.idlePos.y && room.name === creep.memory.idlePos.room) {
                return true;
            } else {
                var targetPosCached = room.getPositionAt(creep.memory.idlePos.x, creep.memory.idlePos.y);
                if (targetPosCached) {
                    creep.moveTo(targetPosCached, { reusePath: 30, visualizePathStyle: { stroke: '#8888ff' } });
                    return true;
                }
                delete creep.memory.idlePos;
            }
        }

        var idlePos = this.findIdleSpotNearController(room, creep);
        if (idlePos) {
            creep.memory.idlePos = { x: idlePos.x, y: idlePos.y, room: room.name };
            if (!(creep.pos.x === idlePos.x && creep.pos.y === idlePos.y && room.name === idlePos.roomName)) {
                creep.moveTo(idlePos, { reusePath: 30, visualizePathStyle: { stroke: '#8888ff' } });
            }
            return true;
        }

        return false;
    },

    findIdleSpotNearController: function(room, creep) {
        var controller = room.controller;
        if (!controller) return null;

        var nonRoad = [];
        var withRoad = [];

        var cx = controller.pos.x;
        var cy = controller.pos.y;

        for (var dx = -10; dx <= 10; dx++) {
            for (var dy = -10; dy <= 10; dy++) {
                var x = cx + dx;
                var y = cy + dy;
                if (x < 1 || x > 48 || y < 1 || y > 48) continue;
                if (dx*dx + dy*dy > 100) continue;
                var pos = room.getPositionAt(x, y);
                if (!pos) continue;

                var creepsHere = pos.lookFor(LOOK_CREEPS);
                if (creepsHere && creepsHere.length > 0) continue;

                var terrain = room.getTerrain().get(x, y);
                if (terrain === TERRAIN_MASK_WALL) continue;

                var hasRoad = false;
                var structs = pos.lookFor(LOOK_STRUCTURES);
                var blocked = false;
                for (var s = 0; s < structs.length; s++) {
                    var st = structs[s].structureType;
                    if (st === STRUCTURE_ROAD) { hasRoad = true; continue; }
                    if (st === STRUCTURE_CONTAINER) continue;
                    if (st === STRUCTURE_RAMPART) {
                        var r = structs[s];
                        if (r.my || r.isPublic) continue;
                        blocked = true; break;
                    }
                    blocked = true; break;
                }
                if (blocked) continue;

                if (hasRoad) withRoad.push(pos);
                else nonRoad.push(pos);
            }
        }

        function pickClosest(list) {
            if (list.length === 0) return null;
            var best = list[0];
            var bestRange = creep.pos.getRangeTo(best);
            for (var i = 1; i < list.length; i++) {
                var r = creep.pos.getRangeTo(list[i]);
                if (r < bestRange) { best = list[i]; bestRange = r; }
            }
            return best;
        }

        var chosen = pickClosest(nonRoad);
        if (chosen) return chosen;

        return pickClosest(withRoad);
    },

    // Collect into terminal
    runCollectBot: function(creep, roomName, resourceType) {
        var room = Game.rooms[roomName];
        if (!room) {
            creep.moveTo(new RoomPosition(25, 25, roomName), { reusePath: 20 });
            creep.say('home');
            return;
        }

        var terminal = room.terminal;
        if (!terminal) {
            creep.say('no term');
            return;
        }

        if (!creep.memory.waitingState) {
            creep.memory.waitingState = { isWaiting: false, lastResourceCheck: 0, waitStartTime: 0 };
        }

        // 0) If carrying anything at all, deliver to terminal first
        var used = creep.store.getUsedCapacity();
        if (used > 0) {
            if (creep.pos.isNearTo(terminal)) {
                for (var res in creep.store) {
                    var amt = creep.store[res] || 0;
                    if (amt > 0) {
                        var depositRes = res;
                        var depositAmt = amt;
                        var tr = creep.transfer(terminal, depositRes);
                        if (tr === OK) {
                            // If linked to a local toTerminal operation, record progress
                            var opIdD = creep.memory.terminalOperationId;
                            if (opIdD) {
                                var opsD = Memory.terminalManager && Memory.terminalManager.operations ? Memory.terminalManager.operations : [];
                                for (var oiD = 0; oiD < opsD.length; oiD++) {
                                    var opD = opsD[oiD];
                                    if (!opD || opD.id !== opIdD) continue;
                                    if (opD.type === 'toTerminal' && opD.roomName === roomName && opD.resourceType === depositRes) {
                                        if (typeof opD.amountMoved !== 'number') opD.amountMoved = 0;
                                        opD.amountMoved += depositAmt;
                                    }
                                }
                            }
                        }
                        break;
                    }
                }
            } else {
                creep.moveTo(terminal, { reusePath: 10, visualizePathStyle: { stroke: '#00ff00' } });
            }
            return;
        }

        // 1) Determine need for current resource (prefer op-specific remaining when linked)
        var opId = creep.memory.terminalOperationId;
        var opRemain = null;
        if (opId) {
            var opsList = Memory.terminalManager && Memory.terminalManager.operations ? Memory.terminalManager.operations : [];
            for (var oi0 = 0; oi0 < opsList.length; oi0++) {
                var o0 = opsList[oi0];
                if (!o0) continue;
                if (o0.id === opId && o0.type === 'toTerminal' && o0.roomName === roomName && o0.resourceType === resourceType) {
                    var moved0 = o0.amountMoved || 0;
                    opRemain = Math.max(0, o0.amount - moved0);
                    break;
                }
            }
        }
        var totalNeeded = (opRemain !== null) ? opRemain : this.getResourceNeeded(roomName, resourceType);
        var inTerminal = 0;
        if (opRemain === null) {
            inTerminal = (terminal.store && terminal.store[resourceType]) ? terminal.store[resourceType] : 0;
        }
        var actuallyNeeded = (opRemain !== null) ? opRemain : Math.max(0, totalNeeded - inTerminal);

        // 2) If current resource not needed, pick the next best needed resource (marketSell/transfer-aware)
        if (actuallyNeeded <= 0) {
            var nextRes = this.findNextNeededResourceForRoom(roomName);
            if (nextRes) {
                if (creep.memory.terminalResource !== nextRes) {
                    creep.memory.terminalResource = nextRes;
                    delete creep.memory.sourceId;
                    creep.say(nextRes === RESOURCE_ENERGY ? 'E' : nextRes);
                }
            } else {
                if (!this.idleNearController(creep, room)) {
                    var spot = this.getWaitingSpot(room);
                    if (spot && !creep.pos.isEqualTo(spot)) {
                        creep.moveTo(spot, { reusePath: 20 });
                    }
                }
                creep.say('Idle');
                return;
            }
        }

        // Update resourceType in case we just switched
        resourceType = creep.memory.terminalResource || resourceType;

        // 3) Use cached source if available
        var source = null;
        if (creep.memory.sourceId) {
            source = Game.getObjectById(creep.memory.sourceId);
            if (!source) delete creep.memory.sourceId;
        }

        // 4) Periodically refresh/choose source
        var shouldCheck = (Game.time - creep.memory.waitingState.lastResourceCheck >= 10) || !source;
        if (shouldCheck) {
            creep.memory.waitingState.lastResourceCheck = Game.time;

            var sources = this.findResourceSources(room, resourceType);
            if (sources.length > 0) {
                var best = sources[0];
                creep.memory.sourceId = best.structure.id;
                source = best.structure;
                creep.memory.waitingState.isWaiting = false;
            } else {
                if (!creep.memory.waitingState.isWaiting) {
                    creep.memory.waitingState.isWaiting = true;
                    creep.memory.waitingState.waitStartTime = Game.time;
                }
            }
        }

        // 5) Act on the source every tick
        if (source) {
            if (creep.pos.isNearTo(source)) {
                // Compute op-specific remaining need if available
                var needNow = 0;
                var opRemainNow = null;
                if (opId) {
                    var opsNow = Memory.terminalManager && Memory.terminalManager.operations ? Memory.terminalManager.operations : [];
                    for (var oi1 = 0; oi1 < opsNow.length; oi1++) {
                        var o1 = opsNow[oi1];
                        if (!o1) continue;
                        if (o1.id === opId && o1.type === 'toTerminal' && o1.roomName === roomName && o1.resourceType === resourceType) {
                            var moved1 = o1.amountMoved || 0;
                            opRemainNow = Math.max(0, o1.amount - moved1);
                            break;
                        }
                    }
                }
                if (opRemainNow !== null) {
                    needNow = opRemainNow;
                } else {
                    var totalNeededNow = this.getResourceNeeded(roomName, resourceType);
                    var inTermNow = (terminal.store && terminal.store[resourceType]) ? terminal.store[resourceType] : 0;
                    needNow = Math.max(0, totalNeededNow - inTermNow);
                }

                // Also respect terminal free capacity to avoid over-withdraw
                var termFreeNow = 0;
                if (terminal.store && typeof terminal.store.getFreeCapacity === 'function') {
                    termFreeNow = terminal.store.getFreeCapacity(resourceType);
                } else {
                    termFreeNow = needNow;
                }

                var availableAtSource = (source.store && (source.store[resourceType] || 0)) || 0;
                var withdrawAmount = Math.min(creep.store.getFreeCapacity(), availableAtSource, needNow, termFreeNow);

                if (withdrawAmount > 0) {
                    var res = creep.withdraw(source, resourceType, withdrawAmount);
                    if (res !== OK && res !== ERR_FULL && res !== ERR_NOT_ENOUGH_RESOURCES) {
                        delete creep.memory.sourceId;
                    }
                } else {
                    delete creep.memory.sourceId;
                }
            } else {
                creep.moveTo(source, { reusePath: 10, visualizePathStyle: { stroke: '#ffaa00' } });
                creep.say('get');
            }
        } else {
            if (!this.idleNearController(creep, room)) {
                var waitingSpot = this.getWaitingSpot(room);
                if (waitingSpot && !creep.pos.isEqualTo(waitingSpot)) {
                    creep.moveTo(waitingSpot, { reusePath: 20 });
                }
            }
            creep.say('wait');
        }
    },

    // Drain terminal into storage/container
    runDrainBot: function(creep, roomName, resourceType) {
        var room = Game.rooms[roomName];
        if (!room) {
            creep.moveTo(new RoomPosition(25, 25, roomName), { reusePath: 20 });
            creep.say('home');
            return;
        }
        var terminal = room.terminal;
        if (!terminal) {
            creep.say('no term');
            return;
        }
        if (!creep.memory.waitingState) {
            creep.memory.waitingState = { isWaiting: false, lastResourceCheck: 0, waitStartTime: 0 };
        }

        // Target deposit structure: Storage preferred, else any container with free capacity
        var target = this.findStorageTarget(room, resourceType);

        // If carrying anything, deliver to target first
        var used = creep.store.getUsedCapacity();
        if (used > 0) {
            if (!target) {
                // No target to deposit => idle
                if (!this.idleNearController(creep, room)) {
                    var spot = this.getWaitingSpot(room);
                    if (spot && !creep.pos.isEqualTo(spot)) creep.moveTo(spot, { reusePath: 20 });
                }
                creep.say('no tgt');
                return;
            }
            if (creep.pos.isNearTo(target)) {
                // Prioritize depositing the requested resource type
                var did = false;
                var keys = [];
                for (var k in creep.store) keys.push(k);
                // Sort to put resourceType first
                for (var a = 0; a < keys.length; a++) {
                    if (keys[a] === resourceType) { var tmp = keys[0]; keys[0] = keys[a]; keys[a] = tmp; break; }
                }
                for (var i = 0; i < keys.length; i++) {
                    var res = keys[i];
                    var amt = creep.store[res] || 0;
                    if (amt <= 0) continue;
                    var depositAmt = amt;
                    var tr = creep.transfer(target, res);
                    if (tr === OK) {
                        // Record progress for toStorage operations if this was the target resource
                        if (res === resourceType) {
                            var opId = creep.memory.terminalOperationId;
                            if (opId) {
                                var ops = Memory.terminalManager && Memory.terminalManager.operations ? Memory.terminalManager.operations : [];
                                for (var oi = 0; oi < ops.length; oi++) {
                                    var op = ops[oi];
                                    if (!op || op.id !== opId) continue;
                                    if (op.type === 'toStorage' && op.roomName === roomName && op.resourceType === res) {
                                        if (typeof op.amountMoved !== 'number') op.amountMoved = 0;
                                        op.amountMoved += depositAmt;
                                    }
                                }
                            }
                        }
                        did = true;
                        break;
                    } else if (tr === ERR_FULL) {
                        // Try alternate target
                        target = this.findStorageTarget(room, resourceType, true);
                        if (target && !creep.pos.isNearTo(target)) creep.moveTo(target, { reusePath: 10, visualizePathStyle: { stroke: '#00aaff' } });
                        break;
                    } else {
                        // Try another resource
                        continue;
                    }
                }
                if (!did) {
                    // nothing transferred; try moving to target again
                    creep.moveTo(target, { reusePath: 10, visualizePathStyle: { stroke: '#00aaff' } });
                }
            } else {
                creep.moveTo(target, { reusePath: 10, visualizePathStyle: { stroke: '#00aaff' } });
                creep.say('drop');
            }
            return;
        }

        // If empty: withdraw from terminal the requested resource
        var opId = creep.memory.terminalOperationId;
        var remaining = null;
        if (opId) {
            var ops = Memory.terminalManager && Memory.terminalManager.operations ? Memory.terminalManager.operations : [];
            for (var oi2 = 0; oi2 < ops.length; oi2++) {
                var op2 = ops[oi2];
                if (!op2 || op2.id !== opId) continue;
                if (op2.type === 'toStorage' && op2.roomName === roomName && op2.resourceType === resourceType) {
                    var moved = op2.amountMoved || 0;
                    remaining = Math.max(0, op2.amount - moved);
                    break;
                }
            }
        }
        if (remaining === null) remaining = creep.store.getCapacity ? creep.store.getCapacity() : creep.store.getFreeCapacity();

        var available = (terminal.store && terminal.store[resourceType]) ? terminal.store[resourceType] : 0;
        if (available <= 0 || !target) {
            // No work possible; idle
            if (!this.idleNearController(creep, room)) {
                var w = this.getWaitingSpot(room);
                if (w && !creep.pos.isEqualTo(w)) creep.moveTo(w, { reusePath: 20 });
            }
            creep.say('wait');
            return;
        }

        var amtToWithdraw = Math.min(available, creep.store.getFreeCapacity(), remaining);
        if (amtToWithdraw <= 0) {
            creep.say('cap');
            return;
        }

        if (creep.pos.isNearTo(terminal)) {
            var resW = creep.withdraw(terminal, resourceType, amtToWithdraw);
            if (resW !== OK && resW !== ERR_FULL && resW !== ERR_NOT_ENOUGH_RESOURCES) {
                creep.say('w err');
            } else {
                creep.say('take');
            }
        } else {
            creep.moveTo(terminal, { reusePath: 10, visualizePathStyle: { stroke: '#ffaa00' } });
            creep.say('get');
        }
    },

    findResourceSources: function(room, resourceType) {
        var sources = [];

        if (room.storage && room.storage.store && (room.storage.store[resourceType] || 0) > 0) {
            sources.push({
                structure: room.storage,
                amount: room.storage.store[resourceType],
                type: 'storage',
                priority: 1
            });
        }

        // Use getRoomState for factories, containers, labs
        var state = getRoomState.get(room.name);
        var stMap = state && state.structuresByType ? state.structuresByType : {};

        // Factories (owned)
        var factories = stMap[STRUCTURE_FACTORY] || [];
        for (var f = 0; f < factories.length; f++) {
            var fac = factories[f];
            if (!fac.my) continue;
            if (!fac.store || !(fac.store[resourceType] || 0)) continue;
            sources.push({
                structure: fac,
                amount: fac.store[resourceType],
                type: 'factory',
                priority: 2
            });
        }

        // Containers (all)
        var containers = stMap[STRUCTURE_CONTAINER] || [];
        for (var i = 0; i < containers.length; i++) {
            var container = containers[i];
            if (!container.store || !(container.store[resourceType] || 0)) continue;
            sources.push({
                structure: container,
                amount: container.store[resourceType],
                type: 'container',
                priority: 2
            });
        }

        // Labs (owned)
        var labs = stMap[STRUCTURE_LAB] || [];
        for (var i2 = 0; i2 < labs.length; i2++) {
            var lab = labs[i2];
            if (!lab.my) continue;
            if (!lab.store || !(lab.store[resourceType] || 0)) continue;
            sources.push({
                structure: lab,
                amount: lab.store[resourceType],
                type: 'lab',
                priority: 3
            });
        }

        sources.sort(function(a, b) {
            if (a.priority !== b.priority) return a.priority - b.priority;
            return b.amount - a.amount;
        });

        return sources;
    },

    getWaitingSpot: function(room) {
        var terrain = room.getTerrain();

        var corners = [
            { x: 2, y: 2 },
            { x: 47, y: 2 },
            { x: 2, y: 47 },
            { x: 47, y: 47 }
        ];

        for (var i = 0; i < corners.length; i++) {
            var corner = corners[i];
            if (terrain.get(corner.x, corner.y) !== TERRAIN_MASK_WALL) {
                var pos = room.getPositionAt(corner.x, corner.y);
                if (pos) {
                    var creeps = pos.lookFor(LOOK_CREEPS);
                    if (creeps.length === 0) {
                        return pos;
                    }
                }
            }
        }

        return null;
    },

    cleanupCompletedOperations: function() {
        if (Game.time % 100 === 0) {
            var operations = Memory.terminalManager.operations;

            for (var i = operations.length - 1; i >= 0; i--) {
                var operation = operations[i];
                var shouldRemove = false;

                if ((operation.type === 'transfer' ||
                     operation.type === 'toTerminal' ||
                     operation.type === 'toStorage') &&
                    (operation.status === 'completed' || operation.status === 'failed') &&
                    (Game.time - operation.created) > 1000) {
                    shouldRemove = true;
                }

                if (shouldRemove) {
                    operations.splice(i, 1);
                }
            }
        }
    },

    // ===== UTILITY FUNCTIONS =====
    // Check if a room is involved in any active transfer operations
    isRoomBusyWithTransfer: function(roomName) {
        const ops = (Memory.terminalManager && Memory.terminalManager.operations) ? Memory.terminalManager.operations : [];
        for (let i = 0; i < ops.length; i++) {
            const op = ops[i];
            if (op.type === 'transfer' &&
                op.status !== 'completed' &&
                op.status !== 'failed' &&
                (op.fromRoom === roomName || op.toRoom === roomName)) return true;
        }
        return false;
    },

    // Auto-cancel operations stuck in 'waiting' longer than threshold.
    // Legacy waiting ops without _waitingSince start from their created tick.
    checkAndCancelStuckWaits: function(maxTicksWaiting) {
        if (typeof maxTicksWaiting !== 'number' || maxTicksWaiting <= 0) maxTicksWaiting = 5000;

        var ops = Memory.terminalManager && Memory.terminalManager.operations ? Memory.terminalManager.operations : [];
        for (var i = ops.length - 1; i >= 0; i--) {
            var op = ops[i];
            if (!op) continue;

            if (op.status !== 'waiting') {
                if (op._waitingSince) delete op._waitingSince;
                continue;
            }

            var start = (typeof op._waitingSince === 'number') ?
                op._waitingSince :
                (typeof op.created === 'number' ? op.created : Game.time);

            op._waitingSince = start;

            var waited = Game.time - start;
            if (waited >= maxTicksWaiting) {
                this.cancelOperation(op.id);
            }
        }
    },

    validateResource: function(resourceType) {
        var validResources = [
            RESOURCE_ENERGY, RESOURCE_POWER,
            RESOURCE_HYDROGEN, RESOURCE_OXYGEN, RESOURCE_UTRIUM, RESOURCE_LEMERGIUM,
            RESOURCE_KEANIUM, RESOURCE_ZYNTHIUM, RESOURCE_CATALYST,
            RESOURCE_HYDROXIDE, RESOURCE_ZYNTHIUM_KEANITE, RESOURCE_UTRIUM_LEMERGITE,
            RESOURCE_UTRIUM_HYDRIDE, RESOURCE_UTRIUM_OXIDE, RESOURCE_KEANIUM_HYDRIDE,
            RESOURCE_KEANIUM_OXIDE, RESOURCE_LEMERGIUM_HYDRIDE, RESOURCE_LEMERGIUM_OXIDE,
            RESOURCE_ZYNTHIUM_HYDRIDE, RESOURCE_ZYNTHIUM_OXIDE, RESOURCE_GHODIUM_HYDRIDE,
            RESOURCE_GHODIUM_OXIDE, RESOURCE_CATALYZED_UTRIUM_ACID, RESOURCE_CATALYZED_UTRIUM_ALKALIDE,
            RESOURCE_CATALYZED_KEANIUM_ACID, RESOURCE_CATALYZED_KEANIUM_ALKALIDE,
            RESOURCE_CATALYZED_LEMERGIUM_ACID, RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
            RESOURCE_CATALYZED_ZYNTHIUM_ACID, RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE,
            RESOURCE_CATALYZED_GHODIUM_ACID, RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
            RESOURCE_UTRIUM_BAR, RESOURCE_LEMERGIUM_BAR, RESOURCE_ZYNTHIUM_BAR,
            RESOURCE_KEANIUM_BAR, RESOURCE_GHODIUM_MELT, RESOURCE_OXIDANT,
            RESOURCE_REDUCTANT, RESOURCE_PURIFIER, RESOURCE_BATTERY,
            RESOURCE_COMPOSITE, RESOURCE_CRYSTAL, RESOURCE_LIQUID,
            RESOURCE_WIRE, RESOURCE_SWITCH, RESOURCE_TRANSISTOR,
            RESOURCE_MICROCHIP, RESOURCE_CIRCUIT, RESOURCE_DEVICE,
            RESOURCE_CELL, RESOURCE_PHLEGM, RESOURCE_TISSUE,
            RESOURCE_MUSCLE, RESOURCE_ORGANOID, RESOURCE_ORGANISM,
            RESOURCE_ALLOY, RESOURCE_TUBE, RESOURCE_FIXTURES,
            RESOURCE_FRAME, RESOURCE_HYDRAULICS, RESOURCE_MACHINE,
            RESOURCE_CONDENSATE, RESOURCE_CONCENTRATE, RESOURCE_EXTRACT,
            RESOURCE_SPIRIT, RESOURCE_EMANATION, RESOURCE_ESSENCE,
            RESOURCE_UTRIUM_ACID, RESOURCE_UTRIUM_ALKALIDE,
            RESOURCE_KEANIUM_ACID, RESOURCE_KEANIUM_ALKALIDE,
            RESOURCE_LEMERGIUM_ACID, RESOURCE_LEMERGIUM_ALKALIDE,
            RESOURCE_ZYNTHIUM_ACID, RESOURCE_ZYNTHIUM_ALKALIDE,
            RESOURCE_GHODIUM_ACID, RESOURCE_GHODIUM_ALKALIDE,
            RESOURCE_GHODIUM, RESOURCE_BIOMASS,
            RESOURCE_METAL, RESOURCE_MIST,
            RESOURCE_SILICON
        ];
        for (var i = 0; i < validResources.length; i++) {
            if (validResources[i] === resourceType) return true;
        }
        return false;
    },

    getAllTerminalBots: function() {
        var list = [];
        var creeps = Game.creeps;
        for (var name in creeps) {
            var creep = creeps[name];
            if (!creep || !creep.memory) continue;
            if (creep.memory.role === 'terminalBot' &&
                typeof creep.memory.terminalRoom === 'string' &&
                typeof creep.memory.terminalTask === 'string') {
                list.push(creep);
            }
        }
        return list;
    },

    // Returns how much of resourceType is needed in roomName's terminal across active transfer operations
    getResourceNeeded: function(roomName, resourceType) {
        var needed = 0;
        var ops = Memory.terminalManager && Memory.terminalManager.operations ? Memory.terminalManager.operations : [];

        for (var i = 0; i < ops.length; i++) {
            var op = ops[i];
            if (!op) continue;
            if (op.status === 'completed' || op.status === 'failed') continue;

            if (op.type === 'transfer' && op.fromRoom === roomName) {
                var remaining = Math.max(0, op.amount - (op.amountTransferred || 0));
                if (remaining <= 0) continue;

                if (op.resourceType === resourceType) {
                    needed += remaining;
                }

                if (resourceType === RESOURCE_ENERGY && remaining > 0) {
                    // Energy required to pay transfer cost, plus payload if sending energy
                    var cost = Game.market.calcTransactionCost(remaining, op.fromRoom, op.toRoom);
                    if (op.resourceType === RESOURCE_ENERGY) {
                        needed += remaining + cost;
                    } else {
                        needed += cost;
                    }
                }
            }

            // Include local toTerminal operations (only the target resource)
            if (op.type === 'toTerminal' && op.roomName === roomName && op.resourceType === resourceType) {
                var moved = op.amountMoved || 0;
                var remainLocal = Math.max(0, op.amount - moved);
                needed += remainLocal;
            }
        }

        return needed;
    },

    sendNotification: function(message) {
        if (Memory.terminalManager.settings.emailNotifications) {
            Game.notify(message);
        }
        console.log('[Terminal Notification] ' + message);
    },

    bodyCost: function(body) {
        var BODYPART_COST = {
            move: 50, work: 100, attack: 80, carry: 50, heal: 250,
            ranged_attack: 150, tough: 10, claim: 600
        };
        var total = 0;
        for (var i = 0; i < body.length; i++) total += BODYPART_COST[body[i]];
        return total;
    },

    getCreepBody: function(role, energy) {
        var bodyConfigs = {
            supplier: {
                200:  [CARRY, CARRY, MOVE, MOVE],
                300:  [CARRY, CARRY, CARRY, MOVE, MOVE, MOVE],
                400:  [CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE],
                600:  [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE]
            }
        };

        var configs = bodyConfigs[role] || bodyConfigs.supplier;
        var tiers = [];
        for (var key in configs) tiers.push(Number(key));
        tiers.sort(function(a, b){ return a - b; });

        var bestTier = tiers[0];
        for (var i = 0; i < tiers.length; i++) {
            var tier = tiers[i];
            if (energy >= tier) bestTier = tier;
            else break;
        }

        return configs[bestTier];
    },

    // Amount available in-room outside the terminal
    getRoomAvailableOutsideTerminal: function(roomName, resourceType) {
        var room = Game.rooms[roomName];
        if (!room) return 0;

        var total = 0;

        var storage = room.storage;
        if (storage && storage.store && storage.store[resourceType]) {
            total += storage.store[resourceType];
        }

        // Use getRoomState for containers, labs, factory
        var state = getRoomState.get(roomName);
        var stMap = state && state.structuresByType ? state.structuresByType : {};

        // Containers (all)
        var containers = stMap[STRUCTURE_CONTAINER] || [];
        for (var i = 0; i < containers.length; i++) {
            var cont = containers[i];
            if (cont.store && (cont.store[resourceType] || 0) > 0) {
                total += cont.store[resourceType];
            }
        }

        // Labs (owned)
        var labs = stMap[STRUCTURE_LAB] || [];
        for (var j = 0; j < labs.length; j++) {
            var lab = labs[j];
            if (!lab.my) continue;
            if (lab.store && (lab.store[resourceType] || 0) > 0) {
                total += lab.store[resourceType];
            }
        }

        // Factory (owned; at most 1)
        var factories = stMap[STRUCTURE_FACTORY] || [];
        for (var k = 0; k < factories.length; k++) {
            var fac = factories[k];
            if (!fac.my) continue;
            if (fac.store && (fac.store[resourceType] || 0) > 0) {
                total += fac.store[resourceType];
                break;
            }
        }

        return total;
    },

    // Choose a deposit target for draining: Storage preferred, else any container with free capacity
    findStorageTarget: function(room, resourceType, preferAlternate) {
        // preferAlternate indicates we are looking for non-storage fallback (after storage full)
        if (!preferAlternate) {
            if (room.storage && room.storage.store) {
                // If it has space (best-effort check), prefer it
                var canUse = true;
                if (room.storage.store.getFreeCapacity && typeof room.storage.store.getFreeCapacity === 'function') {
                    canUse = room.storage.store.getFreeCapacity(resourceType) > 0;
                }
                if (canUse) return room.storage;
            }
        }

        // Containers fallback
        var state = getRoomState.get(room.name);
        var stMap = state && state.structuresByType ? state.structuresByType : {};
        var containers = stMap[STRUCTURE_CONTAINER] || [];
        var best = null;
        for (var i = 0; i < containers.length; i++) {
            var cont = containers[i];
            if (!cont || !cont.store) continue;
            var freeOk = true;
            if (cont.store.getFreeCapacity && typeof cont.store.getFreeCapacity === 'function') {
                freeOk = cont.store.getFreeCapacity(resourceType) > 0;
            }
            if (!freeOk) continue;
            // Pick the first usable
            best = cont;
            break;
        }
        if (best) return best;

        // As last resort, try storage anyway (even if full check failed)
        if (room.storage && room.storage.store) return room.storage;

        return null;
    },

    // ===== MARKETSELL SUPPORT =====
    // Proactively request a bot whenever a marketSell deficit exists and outside supply is available.
    // Does not consider energy and respects the one-bot cap + existing requests.
    ensureBotsForMarketSellNeeds: function() {
        var rooms = Game.rooms;
        for (var rn in rooms) {
            var room = rooms[rn];
            if (!room || !room.controller || !room.controller.my) continue;
            if (!room.terminal) continue;

            // Determine the next needed resource considering marketSell and transfers
            var nextRes = this.findNextNeededResourceForRoom(rn);
            if (!nextRes) continue;

            // Do not auto-request for energy here (you asked not to consider energy)
            if (nextRes === RESOURCE_ENERGY) continue;

            // Confirm net need exists
            var need = this.getResourceNeeded(rn, nextRes);
            var have = (room.terminal.store && room.terminal.store[nextRes]) ? room.terminal.store[nextRes] : 0;
            var netNeeded = Math.max(0, need - have);
            if (netNeeded <= 0) continue;

            // Confirm there is something to collect in-room
            var outside = this.getRoomAvailableOutsideTerminal(rn, nextRes);
            if (outside <= 0) continue;

            // Request a bot; requestBot enforces single-bot cap and avoids duplicates
            this.requestBot(rn, 'collect', nextRes, null);
        }
    },

    // ====== INTERNAL HELPERS (not exposed as globals) ======

    // Sum of a resource in room.storage, containers, labs, factory (already provided for transfer 'max')
    getRoomTotalAvailable: function(roomName, resourceType) {
        var total = 0;
        var room = Game.rooms[roomName];
        if (!room) return 0;

        if (room.storage && room.storage.store && room.storage.store[resourceType]) {
            total += room.storage.store[resourceType];
        }
        // Use getRoomState
        var state = getRoomState.get(roomName);
        var stMap = state && state.structuresByType ? state.structuresByType : {};

        var containers = stMap[STRUCTURE_CONTAINER] || [];
        for (var i = 0; i < containers.length; i++) {
            var c = containers[i];
            if (c.store && c.store[resourceType]) total += c.store[resourceType];
        }

        var labs = stMap[STRUCTURE_LAB] || [];
        for (var j = 0; j < labs.length; j++) {
            var l = labs[j];
            if (l.my && l.store && l.store[resourceType]) total += l.store[resourceType];
        }

        var factories = stMap[STRUCTURE_FACTORY] || [];
        for (var k = 0; k < factories.length; k++) {
            var f = factories[k];
            if (f.my && f.store && f.store[resourceType]) { total += f.store[resourceType]; break; }
        }

        return total;
    }
};

// ===== GLOBAL CONSOLE COMMANDS =====

global.transferStuff = function(fromRoom, toRoom, resourceType, amount) {
    return terminalManager.transferStuff(fromRoom, toRoom, resourceType, amount);
};

global.terminalStatus = function() {
    return terminalManager.status();
};

global.whyTerminal = function(roomName) {
    return terminalManager.whyTerminal(roomName);
};

global.cancelTerminalOperation = function(operationId) {
    return terminalManager.cancelOperation(operationId);
};

global.isRoomBusy = function(roomName) {
    return terminalManager.isRoomBusyWithTransfer(roomName);
};

// NEW globals
global.storageToTerminal = function(roomName, resourceType, amount) {
    return terminalManager.storageToTerminal(roomName, resourceType, amount);
};
global.terminalToStorage = function(roomName, resourceType, amount) {
    return terminalManager.terminalToStorage(roomName, resourceType, amount);
};

module.exports = terminalManager;
