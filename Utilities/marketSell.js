// marketSell.js
//
// Usage:
// - Post a sell order using dynamic pricing:
//      marketSell('E1S1', RESOURCE_ZYNTHIUM, 5000)
// - Post a sell order at a fixed price:
//      marketSell('E1S1', RESOURCE_ZYNTHIUM, 5000, 2.75)
// - Sell everything in a room (except energy):
//      marketSell('E1S1', 'Everything')
//      Scans terminal + storage for all resources, skips any that already have an
//      active SELL order in the room, and creates orders for the full available amount.

var terminalManager = require('terminalManager');
var storageManager = require('storageManager');

// Additional resource types that are valid to sell but may not be in
// terminalManager's validateResource whitelist.
var EXTRA_ALLOWED_RESOURCES = [
    RESOURCE_OPS
];

var marketSeller = {

    // Minimal memory for tracking marketSell -> terminalManager local op linkage
    ensureMemory: function() {
        if (!Memory.marketSell) {
            Memory.marketSell = { requests: [] };
        } else if (!Array.isArray(Memory.marketSell.requests)) {
            Memory.marketSell.requests = [];
        }
    },

    // Check if a resource is in the extra allowed list
    isExtraAllowed: function(resourceType) {
        for (var i = 0; i < EXTRA_ALLOWED_RESOURCES.length; i++) {
            if (EXTRA_ALLOWED_RESOURCES[i] === resourceType) return true;
        }
        return false;
    },

    // Cancel OUR SELL orders that are fully depleted (remainingAmount === 0)
    // Frees up market order slots when at the 300 order cap.
    cancelZeroRemainingSellOrders: function() {
        if (!Game.market || !Game.market.orders) return 0;

        var canceled = 0;
        var myOrders = Game.market.orders;

        for (var id in myOrders) {
            var o = myOrders[id];
            if (!o) continue;
            if (o.type !== ORDER_SELL) continue;

            if (typeof o.remainingAmount === 'number' && o.remainingAmount === 0) {
                var result = Game.market.cancelOrder(id);
                if (result === OK) canceled++;
            }
        }

        return canceled;
    },

    // Compute how much of resourceType exists in the room total = terminal + outside terminal,
    // minus any existing storageManager reservations (so we don't double-commit resources).
    getRoomTotalAvailable: function(roomName, resourceType) {
        var room = Game.rooms[roomName];
        if (!room) return 0;

        var total = 0;

        var terminal = room.terminal;
        if (terminal && terminal.store && terminal.store[resourceType]) {
            total += terminal.store[resourceType];
        }

        // Use terminalManager helper for everything outside the terminal.
        if (terminalManager && typeof terminalManager.getRoomAvailableOutsideTerminal === 'function') {
            total += terminalManager.getRoomAvailableOutsideTerminal(roomName, resourceType) || 0;
        }

        // Subtract existing reservations (from all programs including our own prior orders)
        var info = storageManager.storageFind(roomName, resourceType);
        if (info && info.combined && typeof info.combined.reserved === 'number') {
            total = Math.max(0, total - info.combined.reserved);
        }

        return total;
    },

    // Determine dynamic price if not provided by caller.
    computePrice: function(resourceType) {
        // Get all sell orders for this resource
        var orders = Game.market.getAllOrders({ type: ORDER_SELL, resourceType: resourceType });

        // Build set of our rooms to filter out our own orders
        var myRooms = {};
        for (var rn in Game.rooms) {
            var r = Game.rooms[rn];
            if (r && r.controller && r.controller.my) {
                myRooms[rn] = true;
            }
        }

        // Filter for valid external orders with >= 1000 remaining
        var validOrders = [];
        for (var i = 0; i < orders.length; i++) {
            var o = orders[i];
            if (!o || o.type !== ORDER_SELL) continue;
            if (typeof o.remainingAmount !== 'number' || o.remainingAmount < 1000) continue;
            if (o.roomName && myRooms[o.roomName]) continue;
            if (typeof o.price !== 'number') continue;

            validOrders.push(o);
        }

        // Sort by price (lowest to highest)
        validOrders.sort(function(a, b) {
            return a.price - b.price;
        });

        // Calculate historical average FIRST.
        var hist = Game.market.getHistory(resourceType) || [];
        var count = 0;
        var sum = 0;

        if (hist.length >= 1) {
            var h1 = hist[hist.length - 1];
            if (h1 && typeof h1.avgPrice === 'number') { sum += h1.avgPrice; count++; }
        }
        if (hist.length >= 2) {
            var h2 = hist[hist.length - 2];
            if (h2 && typeof h2.avgPrice === 'number') { sum += h2.avgPrice; count++; }
        }

        var avg = (count > 0) ? (sum / count) : 1;

        // If we found valid orders, use the lowest price (Undercutting Strategy)
        if (validOrders.length > 0) {
            var bestPrice = validOrders[0].price;
            var p = bestPrice - 0.1;

            var maxPrice = avg * 1.5;
            if (p > maxPrice) {
                p = maxPrice;
            }

            return Math.max(p, 0.001);
        }

        // No valid orders with >= 1000 units - fall back to historical average (Fallback Strategy)
        var price = avg * 1.05;
        return Math.max(price, 0.001);
    },

    // How much of resourceType in the terminal is already committed by existing SELL orders
    getExistingSellReservations: function(roomName, resourceType) {
        var reserved = 0;

        var myOrders = Game.market && Game.market.orders ? Game.market.orders : null;
        if (!myOrders) return 0;

        for (var id in myOrders) {
            var o = myOrders[id];
            if (!o) continue;
            if (o.type !== ORDER_SELL) continue;
            if (o.roomName !== roomName) continue;
            if (o.resourceType !== resourceType) continue;
            if (typeof o.remainingAmount !== 'number' || o.remainingAmount <= 0) continue;

            reserved += o.remainingAmount;
        }

        // Don't reserve more than exists in the terminal
        var room = Game.rooms[roomName];
        var terminal = room && room.terminal ? room.terminal : null;
        var haveInTerminal = (terminal && terminal.store && terminal.store[resourceType]) ? terminal.store[resourceType] : 0;

        if (reserved > haveInTerminal) reserved = haveInTerminal;
        return reserved;
    },

    // Link the just-created toTerminal op (created this tick) so we can show/cancel later.
    tryLinkLocalOp: function(roomName, resourceType, amount) {
        if (!Memory.terminalManager || !Array.isArray(Memory.terminalManager.operations)) return null;
        var ops = Memory.terminalManager.operations;
        for (var i = 0; i < ops.length; i++) {
            var op = ops[i];
            if (!op) continue;
            if (op.type !== 'toTerminal') continue;
            if (op.roomName !== roomName) continue;
            if (op.resourceType !== resourceType) continue;
            if (op.amount !== amount) continue;
            if (op.created !== Game.time) continue;
            return op.id;
        }
        return null;
    },

    // Helper: find the id of our own SELL order created this tick with given parameters.
    findOrderId: function(roomName, resourceType, amount, price, createdTick) {
        if (!Game.market || !Game.market.orders) return null;
        var myOrders = Game.market.orders;
        for (var id in myOrders) {
            var o = myOrders[id];
            if (!o) continue;
            if (o.type !== ORDER_SELL) continue;
            if (o.roomName !== roomName) continue;
            if (o.resourceType !== resourceType) continue;
            if (typeof o.totalAmount !== 'number' || typeof o.price !== 'number') continue;
            if (o.totalAmount !== amount) continue;
            if (o.price !== price) continue;
            if (typeof createdTick === 'number') {
                if (typeof o.created !== 'number') continue;
                if (o.created !== createdTick) continue;
            }
            return id;
        }
        return null;
    },

    // Returns a set of resourceTypes that already have an active SELL order in this room.
    getResourcesWithActiveSellOrders: function(roomName) {
        var active = {};
        var myOrders = Game.market && Game.market.orders ? Game.market.orders : null;
        if (!myOrders) return active;

        for (var id in myOrders) {
            var o = myOrders[id];
            if (!o) continue;
            if (o.type !== ORDER_SELL) continue;
            if (o.roomName !== roomName) continue;
            if (typeof o.remainingAmount !== 'number' || o.remainingAmount <= 0) continue;
            active[o.resourceType] = true;
        }
        return active;
    },

    // Collect all unique resource types present in terminal + storage (excluding energy).
    getRoomResourceList: function(roomName) {
        var room = Game.rooms[roomName];
        if (!room) return [];

        var seen = {};

        var terminal = room.terminal;
        if (terminal && terminal.store) {
            for (var res in terminal.store) {
                if (res === RESOURCE_ENERGY) continue;
                if (terminal.store[res] > 0) {
                    seen[res] = true;
                }
            }
        }

        var storage = room.storage;
        if (storage && storage.store) {
            for (var res2 in storage.store) {
                if (res2 === RESOURCE_ENERGY) continue;
                if (storage.store[res2] > 0) {
                    seen[res2] = true;
                }
            }
        }

        var list = [];
        for (var key in seen) {
            list.push(key);
        }
        list.sort();
        return list;
    },

    // Sell all non-energy resources in a room that don't already have active SELL orders.
    sellEverything: function(roomName) {
        this.ensureMemory();
        this.cleanup();

        var room = Game.rooms[roomName];
        if (!room || !room.controller || !room.controller.my) {
            return '[MarketSell] Invalid room: ' + roomName + '. Must be a room you own.';
        }
        if (!room.terminal) {
            return '[MarketSell] Room ' + roomName + ' has no terminal.';
        }

        var alreadySelling = this.getResourcesWithActiveSellOrders(roomName);
        var allResources = this.getRoomResourceList(roomName);

        var results = [];
        var created = 0;
        var skippedActive = 0;
        var skippedInvalid = 0;

        for (var i = 0; i < allResources.length; i++) {
            var res = allResources[i];

            if (alreadySelling[res]) {
                skippedActive++;
                continue;
            }

            var tmValid = terminalManager && typeof terminalManager.validateResource === 'function' && terminalManager.validateResource(res);
            if (!tmValid && !this.isExtraAllowed(res)) {
                skippedInvalid++;
                continue;
            }

            var totalAvailable = this.getRoomTotalAvailable(roomName, res);
            if (totalAvailable <= 0) continue;

            var result = this.marketSell(roomName, res, totalAvailable);
            results.push(result);
            if (result.indexOf('Created SELL order') !== -1) {
                created++;
            }
        }

        var summary = '[MarketSell] sellEverything(' + roomName + '): ' + created + ' orders created';
        if (skippedActive > 0) summary += ', ' + skippedActive + ' skipped (already selling)';
        if (skippedInvalid > 0) summary += ', ' + skippedInvalid + ' skipped (invalid resource type)';
        console.log(summary);

        for (var j = 0; j < results.length; j++) {
            console.log('  ' + results[j]);
        }

        return summary;
    },

    // Main API: marketSell('ROOM#', RESOURCE, AMOUNT[, price])
    //           marketSell('ROOM#', 'Everything')
    marketSell: function(roomName, resourceType, amount, price) {
        if (resourceType === 'Everything') {
            return this.sellEverything(roomName);
        }

        this.ensureMemory();
        this.cleanup();

        var tmValid = terminalManager && typeof terminalManager.validateResource === 'function' && terminalManager.validateResource(resourceType);
        if (!tmValid && !this.isExtraAllowed(resourceType)) {
            return '[MarketSell] Invalid resource type: ' + resourceType;
        }
        if (!amount || amount <= 0) {
            return '[MarketSell] Invalid amount: ' + amount;
        }

        var room = Game.rooms[roomName];
        if (!room || !room.controller || !room.controller.my) {
            return '[MarketSell] Invalid room: ' + roomName + '. Must be a room you own.';
        }

        var terminal = room.terminal;
        if (!terminal) {
            return '[MarketSell] Room ' + roomName + ' has no terminal.';
        }

        // Check available stock (respects existing reservations from all programs)
        var totalAvailable = this.getRoomTotalAvailable(roomName, resourceType);
        if (totalAvailable < amount) {
            return '[MarketSell] Not enough ' + resourceType + ' in room ' + roomName + ' to cover order: have ' + totalAvailable + ' available (after reservations) / ' + amount + ' needed';
        }

        // Determine price
        var finalPrice = price;
        if (typeof finalPrice !== 'number') {
            finalPrice = this.computePrice(resourceType);
        }
        if (finalPrice < 0.001) finalPrice = 0.001;

        // If we're at the order cap, try freeing slots
        if (Game.market && Game.market.orders && Object.keys(Game.market.orders).length >= 300) {
            this.cancelZeroRemainingSellOrders();
        }

        // Create the order
        var result = Game.market.createOrder({
            type: ORDER_SELL,
            resourceType: resourceType,
            price: finalPrice,
            totalAmount: amount,
            roomName: roomName
        });

        if (result === ERR_FULL) {
            this.cancelZeroRemainingSellOrders();
            result = Game.market.createOrder({
                type: ORDER_SELL,
                resourceType: resourceType,
                price: finalPrice,
                totalAmount: amount,
                roomName: roomName
            });
        }

        if (result !== OK) {
            return '[MarketSell] Failed to create SELL order: ' + result + ' (room ' + roomName + ', ' + resourceType + ' x ' + amount + ' @ ' + finalPrice + ')';
        }

        // Schedule local move into terminal (reservation-aware)
        var haveInTerminal = (terminal.store && terminal.store[resourceType]) ? terminal.store[resourceType] : 0;

        var outsideAvailable = 0;
        if (terminalManager && typeof terminalManager.getRoomAvailableOutsideTerminal === 'function') {
            outsideAvailable = terminalManager.getRoomAvailableOutsideTerminal(roomName, resourceType) || 0;
        }

        var reservedInTerminal = this.getExistingSellReservations(roomName, resourceType);
        var unreservedInTerminal = Math.max(0, haveInTerminal - reservedInTerminal);
        var coverableNow = Math.min(amount, unreservedInTerminal + outsideAvailable);
        var need = Math.max(0, coverableNow - unreservedInTerminal);

        var tmOpId = null;
        var needsTransfer = false;

        if (need > 0) {
            if (typeof terminalManager.storageToTerminal === 'function') {
                terminalManager.storageToTerminal(roomName, resourceType, need);
                tmOpId = this.tryLinkLocalOp(roomName, resourceType, need);
                needsTransfer = true;
            } else {
                console.log('[MarketSell] Warning: terminalManager.storageToTerminal not available.');
            }
        }

        // Find the created market order id
        var orderId = this.findOrderId(roomName, resourceType, amount, finalPrice, Game.time);

        // Track this marketSell request
        var entry = {
            id: 'marketsell_' + Game.time + '_' + Math.random().toString(36).substr(2, 9),
            roomName: roomName,
            resourceType: resourceType,
            amount: amount,
            price: finalPrice,
            created: Game.time,
            reserved: false,              // NEW: reservation not yet placed
            needsTransfer: needsTransfer  // NEW: whether a toTerminal op was created
        };
        if (tmOpId) entry.tmOpId = tmOpId;
        if (orderId) entry.orderId = orderId;

        Memory.marketSell.requests.push(entry);

        var msg = '[MarketSell] Created SELL order from ' + roomName + ': ' + amount + ' ' + resourceType + ' @ ' + finalPrice.toFixed(3);
        if (need > 0) {
            msg += ' | scheduled to move ' + need + ' into terminal' + (tmOpId ? (' (op ' + tmOpId + ')') : '');
            msg += ' | reservation pending transfer completion';
        } else {
            msg += ' | terminal already has target amount (unreserved: ' + unreservedInTerminal + ')';
            msg += ' | reservation will be placed on next sync';
        }
        return msg;
    },

    // ===== PERIODIC SYNC (call from main loop every ~50 ticks) =====
    run: function() {
        this.ensureMemory();
        this.reconcileOrders();
        this.cleanup();
        this.syncReservations();
    },

    // Reattach live market sell orders to in-memory requests after memory loss
    // or request cleanup. Any sell order in an owned room should belong here.
    reconcileOrders: function() {
        this.ensureMemory();

        if (!Game.market || !Game.market.orders) {
            return '[MarketSell] No market orders to reconcile.';
        }

        var list = Memory.marketSell.requests;
        var knownOrders = {};
        for (var i = 0; i < list.length; i++) {
            var req = list[i];
            if (req && req.orderId) knownOrders[req.orderId] = true;
        }

        var attached = 0;
        var added = 0;

        for (var id in Game.market.orders) {
            var order = Game.market.orders[id];
            if (!order || order.type !== ORDER_SELL) continue;
            if (typeof order.remainingAmount !== 'number' || order.remainingAmount <= 0) continue;
            if (knownOrders[id]) continue;

            var room = Game.rooms[order.roomName];
            if (!room || !room.controller || !room.controller.my) continue;

            var orderAmount = (typeof order.totalAmount === 'number') ? order.totalAmount : (typeof order.amount === 'number' ? order.amount : 0);
            var orderPrice = (typeof order.price === 'number') ? order.price : 0;

            var matched = false;
            for (var j = 0; j < list.length; j++) {
                var candidate = list[j];
                if (!candidate || candidate.orderId) continue;
                if (candidate.roomName !== order.roomName) continue;
                if (candidate.resourceType !== order.resourceType) continue;
                if (candidate.amount !== orderAmount) continue;
                if (candidate.price !== orderPrice) continue;

                candidate.orderId = id;
                candidate.reconciled = true;
                if (candidate.needsTransfer === undefined) candidate.needsTransfer = false;
                matched = true;
                attached++;
                break;
            }

            if (!matched) {
                list.push({
                    id: 'marketsell_reconcile_' + Game.time + '_' + added,
                    roomName: order.roomName,
                    resourceType: order.resourceType,
                    amount: orderAmount,
                    price: orderPrice,
                    created: (typeof order.created === 'number') ? order.created : Game.time,
                    reserved: false,
                    needsTransfer: false,
                    orderId: id,
                    reconciled: true
                });
                added++;
            }

            knownOrders[id] = true;
        }

        if (added === 0 && attached === 0) {
            return '[MarketSell] No orphaned marketSell orders found.';
        }

        return '[MarketSell] Reconciled ' + (added + attached) + ' orphaned marketSell order(s) (' + attached + ' attached, ' + added + ' added).';
    },

    // Sync storageManager reservations with live market order state.
    // - Places reservations once storageToTerminal completes (or wasn't needed).
    // - Updates reservation amounts as orders sell (remainingAmount decreases).
    // - Unreserves when orders are fully sold or cancelled.
    syncReservations: function() {
        var list = Memory.marketSell.requests;
        if (!list || list.length === 0) {
            // No active requests — ensure no stale marketSell reservations remain
            this._unreserveAll();
            return;
        }

        // Aggregate remaining amounts by room+resource for orders that are ready to reserve
        var aggregates = {};  // key: 'room:resource' -> total remainingAmount

        for (var i = 0; i < list.length; i++) {
            var req = list[i];
            if (!req.orderId) continue;

            var order = Game.market && Game.market.orders ? Game.market.orders[req.orderId] : null;
            if (!order || typeof order.remainingAmount !== 'number' || order.remainingAmount <= 0) continue;

            // Check if the toTerminal transfer is complete (or wasn't needed)
            var ready = this._isTransferReady(req);
            if (!ready) continue;

            var key = req.roomName + ':' + req.resourceType;
            if (!aggregates[key]) {
                aggregates[key] = { roomName: req.roomName, resource: req.resourceType, total: 0, reqs: [] };
            }
            aggregates[key].total += order.remainingAmount;
            aggregates[key].reqs.push(req);
        }

        // Apply aggregated reservations (one per room+resource combo)
        // Track which combos we're actively reserving
        var activeKeys = {};

        for (var k in aggregates) {
            var agg = aggregates[k];
            if (agg.total > 0) {
                var room = Game.rooms[agg.roomName];
                var terminal = room && room.terminal ? room.terminal : null;
                var storage = room && room.storage ? room.storage : null;
                var inTerminal = (terminal && terminal.store && terminal.store[agg.resource]) ? terminal.store[agg.resource] : 0;
                var inStorage = (storage && storage.store && storage.store[agg.resource]) ? storage.store[agg.resource] : 0;

                var reserveTerminal = Math.min(agg.total, inTerminal);
                var reserveStorage = Math.min(Math.max(0, agg.total - reserveTerminal), inStorage);

                var terminalOk = true;
                var storageOk = true;

                if (reserveTerminal > 0) {
                    var termResult = storageManager.reserve(agg.roomName, agg.resource, 'terminal', 'marketSell', reserveTerminal);
                    terminalOk = !!(termResult && termResult.ok);
                    if (!terminalOk && Game.time % 100 === 0) {
                        console.log('[MarketSell] Reserve warning for ' + agg.resource + ' in ' + agg.roomName + ' terminal: ' + termResult.reason);
                    }
                    if (!terminalOk) {
                        storageManager.unReserve(agg.roomName, agg.resource, 'terminal', 'marketSell');
                    }
                } else {
                    var termInfo = storageManager.storageFind(agg.roomName, agg.resource);
                    var hasTermReserve = false;
                    if (termInfo && termInfo.terminal && Array.isArray(termInfo.terminal.reservations)) {
                        for (var ti = 0; ti < termInfo.terminal.reservations.length; ti++) {
                            var termResv = termInfo.terminal.reservations[ti];
                            if (termResv && termResv.program === 'marketSell') { hasTermReserve = true; break; }
                        }
                    }
                    if (hasTermReserve) storageManager.unReserve(agg.roomName, agg.resource, 'terminal', 'marketSell');
                }

                if (reserveStorage > 0) {
                    var storResult = storageManager.reserve(agg.roomName, agg.resource, 'storage', 'marketSell', reserveStorage);
                    storageOk = !!(storResult && storResult.ok);
                    if (!storageOk && Game.time % 100 === 0) {
                        console.log('[MarketSell] Reserve warning for ' + agg.resource + ' in ' + agg.roomName + ' storage: ' + storResult.reason);
                    }
                    if (!storageOk) {
                        storageManager.unReserve(agg.roomName, agg.resource, 'storage', 'marketSell');
                    }
                } else {
                    var storInfo = storageManager.storageFind(agg.roomName, agg.resource);
                    var hasStorReserve = false;
                    if (storInfo && storInfo.storage && Array.isArray(storInfo.storage.reservations)) {
                        for (var si = 0; si < storInfo.storage.reservations.length; si++) {
                            var storResv = storInfo.storage.reservations[si];
                            if (storResv && storResv.program === 'marketSell') { hasStorReserve = true; break; }
                        }
                    }
                    if (hasStorReserve) storageManager.unReserve(agg.roomName, agg.resource, 'storage', 'marketSell');
                }

                var fullyReserved = terminalOk && storageOk && (reserveTerminal + reserveStorage >= agg.total);
                for (var ri = 0; ri < agg.reqs.length; ri++) {
                    agg.reqs[ri].reserved = fullyReserved;
                }
                activeKeys[k] = true;
            }
        }

        // Unreserve any room+resource combos that are no longer active
        this._unreserveInactive(activeKeys);
    },

    // Check if a request's toTerminal transfer is complete (or wasn't needed)
    _isTransferReady: function(req) {
        // No transfer was needed — ready immediately
        if (!req.needsTransfer && !req.tmOpId) return true;

        // No op ID tracked — assume ready (conservative; avoids stuck state)
        if (!req.tmOpId) return true;

        // Check the toTerminal operation status
        var ops = (Memory.terminalManager && Array.isArray(Memory.terminalManager.operations))
            ? Memory.terminalManager.operations : [];

        for (var j = 0; j < ops.length; j++) {
            var op = ops[j];
            if (!op) continue;
            if (op.id === req.tmOpId) {
                // Transfer is done
                if (op.status === 'completed') return true;
                // Transfer failed — still allow reservation of whatever made it
                if (op.status === 'failed') return true;
                // Still in progress
                return false;
            }
        }

        // Op not found in memory — likely already cleaned up, treat as complete
        return true;
    },

    // Remove marketSell reservations for combos not in activeKeys
    _unreserveInactive: function(activeKeys) {
        if (!Memory.storageReservations) return;

        var r = Memory.storageReservations;
        var buildings = ['terminal', 'storage'];
        for (var roomName in r) {
            for (var b = 0; b < buildings.length; b++) {
                var building = buildings[b];
                if (!r[roomName] || !r[roomName][building]) continue;
                var bucket = r[roomName][building];

                for (var material in bucket) {
                    var reservations = bucket[material];
                    if (!Array.isArray(reservations)) continue;

                    for (var i = 0; i < reservations.length; i++) {
                        if (reservations[i].program === 'marketSell') {
                            var key = roomName + ':' + material;
                            if (!activeKeys[key]) {
                                storageManager.unReserve(roomName, material, building, 'marketSell');
                            }
                            break; // only one entry per program
                        }
                    }
                }
            }
        }
    },

    // Remove all marketSell reservations (used when no requests remain)
    _unreserveAll: function() {
        this._unreserveInactive({});
    },

    // Convenience helpers for console
    status: function(filterRoom, filterResourceType) {
        this.ensureMemory();
        this.cleanup();

        var list = Memory.marketSell.requests;
        var rows = [];

        for (var i = 0; i < list.length; i++) {
            var r = list[i];
            if (!r) continue;
            if (filterRoom && r.roomName !== filterRoom) continue;
            if (filterResourceType && r.resourceType !== filterResourceType) continue;

            var order = (r.orderId && Game.market && Game.market.orders) ? Game.market.orders[r.orderId] : null;
            var orderRemaining = order ? order.remainingAmount : 0;
            var orderTotal = order ? order.totalAmount : (typeof r.amount === 'number' ? r.amount : 0);

            var info = storageManager.storageFind(r.roomName, r.resourceType);
            var termRsv = info && info.terminal && typeof info.terminal.reserved === 'number' ? info.terminal.reserved : 0;
            var storRsv = info && info.storage && typeof info.storage.reserved === 'number' ? info.storage.reserved : 0;
            var reservedTotal = termRsv + storRsv;
            var shortfall = Math.max(0, orderRemaining - reservedTotal);

            var progress = '-';
            if (r.tmOpId && Memory.terminalManager && Array.isArray(Memory.terminalManager.operations)) {
                var ops = Memory.terminalManager.operations;
                for (var j = 0; j < ops.length; j++) {
                    var op = ops[j];
                    if (op && op.id === r.tmOpId) {
                        var moved = op.amountMoved || 0;
                        if (moved < 0) moved = 0;
                        if (moved > op.amount) moved = op.amount;
                        progress = moved + '/' + op.amount + ' ' + (op.status || '-');
                        break;
                    }
                }
            }

            var state = 'live';
            if (!order) state = 'orphan';
            else if (!r.reserved) state = 'pending';

            rows.push({
                roomName: r.roomName,
                resourceType: r.resourceType,
                orderTotal: orderTotal,
                orderRemaining: orderRemaining,
                termRsv: termRsv,
                storRsv: storRsv,
                shortfall: shortfall,
                price: typeof r.price === 'number' ? r.price : 0,
                created: r.created || 0,
                age: (typeof r.created === 'number' && typeof Game.time === 'number') ? (Game.time - r.created) : '-',
                orderId: r.orderId || '-',
                state: state,
                progress: progress
            });
        }

        var lines = [];
        var roomLabel = filterRoom ? filterRoom : '*';
        var resourceLabel = filterResourceType ? filterResourceType : '*';
        lines.push('[MarketSell] Requests room=' + roomLabel + ' resource=' + resourceLabel);

        if (rows.length === 0) {
            lines.push('  none');
            lines.push('Total requests: 0');
            console.log(lines.join('\n'));
            return '[MarketSell] Status printed.';
        }

        rows.sort(function(a, b) {
            if (a.roomName !== b.roomName) return a.roomName < b.roomName ? -1 : 1;
            if (a.resourceType !== b.resourceType) return a.resourceType < b.resourceType ? -1 : 1;
            return (a.created || 0) - (b.created || 0);
        });

        function padRight(str, len) {
            str = String(str);
            while (str.length < len) str += ' ';
            return str;
        }

        lines.push('room        resource        state    remaining  total      termRsv  storRsv  shortfall  price     age   orderId');
        for (var k = 0; k < rows.length; k++) {
            var row = rows[k];
            lines.push(
                padRight(row.roomName, 11) + ' ' +
                padRight(row.resourceType, 14) + ' ' +
                padRight(row.state, 8) + ' ' +
                padRight(row.orderRemaining, 10) + ' ' +
                padRight(row.orderTotal, 10) + ' ' +
                padRight(row.termRsv, 8) + ' ' +
                padRight(row.storRsv, 8) + ' ' +
                padRight(row.shortfall, 10) + ' ' +
                padRight((typeof row.price === 'number' ? row.price.toFixed(3) : row.price), 8) + ' ' +
                padRight(row.age, 5) + ' ' +
                row.orderId
            );
            if (row.progress !== '-' || row.state !== 'live') {
                lines.push('  ' + row.progress);
            }
        }

        lines.push('Total requests: ' + rows.length);
        console.log(lines.join('\n'));
        return '[MarketSell] Status printed.';
    },

    cancelGather: function(id) {
        this.ensureMemory();
        var list = Memory.marketSell.requests;
        for (var i = list.length - 1; i >= 0; i--) {
            var r = list[i];
            if (r && r.id === id) {
                // Cancel the toTerminal op if linked
                if (r.tmOpId && terminalManager && typeof terminalManager.cancelOperation === 'function') {
                    terminalManager.cancelOperation(r.tmOpId);
                }
                // Release reservation if placed
                if (r.reserved) {
                    // Don't unReserve directly — syncReservations will handle it
                    // since we're removing the request
                }
                list.splice(i, 1);
                // Trigger a reservation sync to clean up
                this.syncReservations();
                return '[MarketSell] Cancelled associated local move and removed request: ' + id;
            }
        }
        return '[MarketSell] Request not found: ' + id;
    },

    // Strict Sync Logic:
    // Only keeps requests where the corresponding Market Order exists AND has > 0 remaining.
    cleanup: function() {
        this.ensureMemory();

        this.cancelZeroRemainingSellOrders();

        var list = Memory.marketSell.requests;
        var myOrders = Game.market.orders;
        var keep = [];
        var removed = 0;

        for (var i = 0; i < list.length; i++) {
            var req = list[i];

            // 1. Always keep requests created THIS tick
            if (req.created === Game.time) {
                keep.push(req);
                continue;
            }

            // 2. Ensure we have an orderId
            if (!req.orderId) {
                var foundId = this.findOrderId(req.roomName, req.resourceType, req.amount, req.price, req.created);
                if (foundId) {
                    req.orderId = foundId;
                } else {
                    if ((Game.time - (req.created || 0)) > 10) {
                        removed++;
                        continue;
                    }
                    keep.push(req);
                    continue;
                }
            }

            // 3. Check against live Game.market.orders
            var order = myOrders[req.orderId];

            if (!order) {
                removed++;
                continue;
            }

            if (order.remainingAmount <= 0) {
                removed++;
                continue;
            }

            // Order is live and has stock remaining. Keep it.
            keep.push(req);
        }

        Memory.marketSell.requests = keep;

        // If we removed anything, sync reservations to release freed stock
        if (removed > 0) {
            this.syncReservations();
        }

        return '[MarketSell] Sync: Pruned ' + removed + ' completed/invalid requests. Active: ' + keep.length;
    }
};

// ===== GLOBAL CONSOLE COMMANDS =====
global.marketSell = function(roomName, resourceType, amount, price) {
    return marketSeller.marketSell(roomName, resourceType, amount, price);
};
global.marketSellStatus = function(roomName, resourceType) {
    return marketSeller.status(roomName, resourceType);
};
global.marketSellReconcile = function() {
    return marketSeller.reconcileOrders();
};
global.cancelMarketSellGather = function(id) {
    return marketSeller.cancelGather(id);
};
global.marketSellCleanup = function() {
    return marketSeller.cleanup();
};

module.exports = marketSeller;
