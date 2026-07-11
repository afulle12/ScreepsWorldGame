// LLM: Read llmcontext.js before reviewing or changing this file.
// marketSell.js
//
// Usage:
// - Post a sell order using dynamic pricing:
//      marketSell('E1S1', RESOURCE_ZYNTHIUM, 5000)
//      If E1S1 already has an active SELL order for zynthium, marketSell extends
//      the most competitive existing order instead of creating a duplicate.
// - Post a sell order at a fixed price:
//      marketSell('E1S1', RESOURCE_ZYNTHIUM, 5000, 2.75)
//      Fixed price is only used when creating a new order. Existing room/resource
//      orders keep their current price and are extended/deduped.
// - Sell everything in a room (except energy):
//      marketSell('E1S1', 'Everything')
//      Scans terminal + storage for all resources, skips any that already have an
//      active SELL order in the room, and creates orders for the full available amount.
// - One-time cleanup for duplicate active SELL orders:
//      marketSellDedupe()
//      marketSellDedupe('E1S1')
//      marketSellDedupe('E1S1', RESOURCE_ZYNTHIUM)
//      Groups by room + resource. For each group, keeps the lowest-price order,
//      extends it by the duplicate orders' remaining amount, then cancels duplicates.

var terminalManager = require('terminalManager');
var pricing = require('marketPricing');
var storageManager = require('storageManager');
var roomSuspender = require('roomSuspender');
var memoryManager = require('memoryManager');
var creditLedger = require('creditLedger');

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
        // Legacy: written by an old version, reader removed from terminalManager
        if (Memory.marketSell.operations !== undefined) delete Memory.marketSell.operations;
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

    // Determine dynamic price if not provided by caller: undercut the best
    // external ask, clamped to 1.5x the 48h average (see marketPricing).
    computePrice: function(resourceType) {
        return pricing.actualSellPrice(resourceType);
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
    findOrderId: function(roomName, resourceType, amount, createdTick) {
        if (!Game.market || !Game.market.orders) return null;
        var myOrders = Game.market.orders;
        for (var id in myOrders) {
            var o = myOrders[id];
            if (!o) continue;
            if (o.type !== ORDER_SELL) continue;
            if (o.roomName !== roomName) continue;
            if (o.resourceType !== resourceType) continue;
            if (typeof o.totalAmount !== 'number') continue;
            if (o.totalAmount !== amount) continue;
            if (typeof createdTick === 'number') {
                if (typeof o.created !== 'number') continue;
                if (o.created !== createdTick) continue;
            }
            return id;
        }
        return null;
    },

    getActiveOwnedSellOrders: function(filterRoom, filterResourceType) {
        var results = [];
        if (!Game.market || !Game.market.orders) return results;

        for (var id in Game.market.orders) {
            var order = Game.market.orders[id];
            if (!order || order.type !== ORDER_SELL) continue;
            if (typeof order.remainingAmount !== 'number' || order.remainingAmount <= 0) continue;
            if (filterRoom && order.roomName !== filterRoom) continue;
            if (filterResourceType && order.resourceType !== filterResourceType) continue;

            var room = Game.rooms[order.roomName];
            if (!room || !room.controller || !room.controller.my) continue;

            results.push({ id: id, order: order });
        }

        return results;
    },

    chooseMostCompetitiveSellOrder: function(entries) {
        if (!entries || entries.length === 0) return null;

        var best = entries[0];
        for (var i = 1; i < entries.length; i++) {
            var candidate = entries[i];
            var bestPrice = (typeof best.order.price === 'number') ? best.order.price : Infinity;
            var candidatePrice = (typeof candidate.order.price === 'number') ? candidate.order.price : Infinity;

            if (candidatePrice < bestPrice) {
                best = candidate;
                continue;
            }
            if (candidatePrice > bestPrice) continue;

            var bestRemaining = (typeof best.order.remainingAmount === 'number') ? best.order.remainingAmount : 0;
            var candidateRemaining = (typeof candidate.order.remainingAmount === 'number') ? candidate.order.remainingAmount : 0;
            if (candidateRemaining > bestRemaining) {
                best = candidate;
                continue;
            }
            if (candidateRemaining < bestRemaining) continue;

            var bestCreated = (typeof best.order.created === 'number') ? best.order.created : 0;
            var candidateCreated = (typeof candidate.order.created === 'number') ? candidate.order.created : 0;
            if (candidateCreated > bestCreated) best = candidate;
        }

        return best;
    },

    planTerminalCoverage: function(roomName, resourceType, amount) {
        var room = Game.rooms[roomName];
        var terminal = room && room.terminal ? room.terminal : null;
        var haveInTerminal = (terminal && terminal.store && terminal.store[resourceType]) ? terminal.store[resourceType] : 0;

        var outsideAvailable = 0;
        if (terminalManager && typeof terminalManager.getRoomAvailableOutsideTerminal === 'function') {
            outsideAvailable = terminalManager.getRoomAvailableOutsideTerminal(roomName, resourceType) || 0;
        }

        var reservedInTerminal = this.getExistingSellReservations(roomName, resourceType);
        var unreservedInTerminal = Math.max(0, haveInTerminal - reservedInTerminal);
        var coverableNow = Math.min(amount, unreservedInTerminal + outsideAvailable);
        var need = Math.max(0, coverableNow - unreservedInTerminal);

        return {
            need: need,
            unreservedInTerminal: unreservedInTerminal
        };
    },

    scheduleTerminalCoverage: function(roomName, resourceType, plan) {
        var need = plan && typeof plan.need === 'number' ? plan.need : 0;
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

        return {
            need: need,
            tmOpId: tmOpId,
            needsTransfer: needsTransfer,
            unreservedInTerminal: plan ? plan.unreservedInTerminal : 0
        };
    },

    removeRequestsForOrderIds: function(orderIds) {
        this.ensureMemory();
        var removed = 0;
        var list = Memory.marketSell.requests;
        var keep = [];

        for (var i = 0; i < list.length; i++) {
            var req = list[i];
            if (req && req.orderId && orderIds[req.orderId]) {
                removed++;
                continue;
            }
            keep.push(req);
        }

        Memory.marketSell.requests = keep;
        if (removed > 0) memoryManager.requestSave();
        return removed;
    },

    ensureRequestForOrder: function(orderId, order, coverage) {
        this.ensureMemory();
        if (!orderId || !order) return null;

        var list = Memory.marketSell.requests;
        var found = null;
        var keep = [];

        for (var i = 0; i < list.length; i++) {
            var req = list[i];
            if (!req || req.orderId !== orderId) {
                keep.push(req);
                continue;
            }

            if (!found) {
                found = req;
                keep.push(req);
            }
        }

        Memory.marketSell.requests = keep;

        var amount = (typeof order.totalAmount === 'number') ? order.totalAmount : (typeof order.amount === 'number' ? order.amount : order.remainingAmount);
        if (!found) {
            found = {
                roomName: order.roomName,
                resourceType: order.resourceType,
                amount: amount,
                created: (typeof order.created === 'number') ? order.created : Game.time,
                orderId: orderId
            };
            Memory.marketSell.requests.push(found);
        } else {
            found.roomName = order.roomName;
            found.resourceType = order.resourceType;
            found.amount = amount;
            found.orderId = orderId;
        }

        if (coverage && coverage.tmOpId) {
            found.tmOpId = coverage.tmOpId;
        }

        memoryManager.requestSave();
        return found;
    },

    consolidateSellOrders: function(filterRoom, filterResourceType, additionalAmount, coverage) {
        this.ensureMemory();

        var active = this.getActiveOwnedSellOrders(filterRoom, filterResourceType);
        var groups = {};
        var key;
        for (var i = 0; i < active.length; i++) {
            var entry = active[i];
            key = entry.order.roomName + ':' + entry.order.resourceType;
            if (!groups[key]) groups[key] = [];
            groups[key].push(entry);
        }

        var summary = {
            groupsScanned: 0,
            groupsDeduped: 0,
            ordersCanceled: 0,
            amountConsolidated: 0,
            amountAdded: 0,
            requestEntriesRemoved: 0,
            failures: []
        };

        for (key in groups) {
            var entries = groups[key];
            if (!entries || entries.length === 0) continue;
            summary.groupsScanned++;

            var parts = key.split(':');
            var roomName = parts[0];
            var resourceType = parts[1];
            var add = (additionalAmount && filterRoom === roomName && filterResourceType === resourceType) ? additionalAmount : 0;
            if (entries.length <= 1 && add <= 0) continue;

            var keeper = this.chooseMostCompetitiveSellOrder(entries);
            if (!keeper) continue;

            var duplicateAmount = 0;
            var duplicateIds = {};
            for (var j = 0; j < entries.length; j++) {
                if (entries[j].id === keeper.id) continue;
                duplicateIds[entries[j].id] = true;
                duplicateAmount += entries[j].order.remainingAmount || 0;
            }

            var extendBy = duplicateAmount + add;
            if (extendBy > 0) {
                var extendFee = pricing.FEE * ((keeper.order && keeper.order.price) || 0) * extendBy;
                if (creditLedger.available() < extendFee) {
                    summary.failures.push(roomName + '/' + resourceType + ': extendOrder(' + keeper.id + ', ' + extendBy + ') skipped - fee ' + extendFee.toFixed(1) + ' exceeds credits available this tick');
                    continue;
                }
                var extendResult = Game.market.extendOrder(keeper.id, extendBy);
                if (extendResult !== OK) {
                    summary.failures.push(roomName + '/' + resourceType + ': extendOrder(' + keeper.id + ', ' + extendBy + ') failed ' + extendResult);
                    continue;
                }
                creditLedger.commit(extendFee);
                summary.amountConsolidated += duplicateAmount;
                summary.amountAdded += add;
            }

            var canceledThisGroup = 0;
            for (var dupId in duplicateIds) {
                var cancelResult = Game.market.cancelOrder(dupId);
                if (cancelResult === OK) {
                    canceledThisGroup++;
                } else {
                    summary.failures.push(roomName + '/' + resourceType + ': cancelOrder(' + dupId + ') failed ' + cancelResult);
                    delete duplicateIds[dupId];
                }
            }

            summary.ordersCanceled += canceledThisGroup;
            if (canceledThisGroup > 0 || add > 0) summary.groupsDeduped++;
            summary.requestEntriesRemoved += this.removeRequestsForOrderIds(duplicateIds);
            this.ensureRequestForOrder(keeper.id, keeper.order, coverage);
        }

        this.syncReservations();
        return summary;
    },

    formatDedupeSummary: function(summary) {
        var msg = '[MarketSell] Dedupe scanned ' + summary.groupsScanned + ' group(s), deduped ' + summary.groupsDeduped + ', canceled ' + summary.ordersCanceled + ' duplicate order(s), consolidated ' + summary.amountConsolidated + ' unit(s)';
        if (summary.amountAdded > 0) msg += ', added ' + summary.amountAdded + ' unit(s)';
        if (summary.requestEntriesRemoved > 0) msg += ', removed ' + summary.requestEntriesRemoved + ' stale request(s)';
        if (summary.failures.length > 0) msg += ', failures: ' + summary.failures.join('; ');
        return msg;
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

        var existingOrders = this.getActiveOwnedSellOrders(roomName, resourceType);
        if (existingOrders.length > 0) {
            var existingCoveragePlan = this.planTerminalCoverage(roomName, resourceType, amount);
            var dedupeSummary = this.consolidateSellOrders(roomName, resourceType, amount, null);
            var dedupeMsg = this.formatDedupeSummary(dedupeSummary);
            if (dedupeSummary.amountAdded > 0) {
                var existingCoverage = this.scheduleTerminalCoverage(roomName, resourceType, existingCoveragePlan);
                var activeAfterExtend = this.getActiveOwnedSellOrders(roomName, resourceType);
                var keeperAfterExtend = this.chooseMostCompetitiveSellOrder(activeAfterExtend);
                if (keeperAfterExtend) {
                    this.ensureRequestForOrder(keeperAfterExtend.id, keeperAfterExtend.order, existingCoverage);
                    this.syncReservations();
                }
                dedupeMsg += ' | extended existing ' + roomName + '/' + resourceType + ' order instead of creating a duplicate';
                if (existingCoverage.need > 0) {
                    dedupeMsg += ' | scheduled to move ' + existingCoverage.need + ' into terminal' + (existingCoverage.tmOpId ? (' (op ' + existingCoverage.tmOpId + ')') : '');
                }
            }
            return dedupeMsg;
        }

        // Determine price
        var finalPrice = price;
        if (typeof finalPrice !== 'number') {
            finalPrice = this.computePrice(resourceType);
        }
        finalPrice = Math.round(finalPrice * 1000) / 1000; // server keeps 3-decimal prices
        if (finalPrice < 0.001) finalPrice = 0.001;

        var creationFee = pricing.FEE * finalPrice * amount;
        if (creditLedger.available() < creationFee) {
            return '[MarketSell] Insufficient credits for SELL order fee: need ' + creationFee.toFixed(1) +
                   ', have ' + creditLedger.available().toFixed(1) + ' available this tick';
        }

        // If we're at the order cap, try freeing slots
        if (Game.market && Game.market.orders && Object.keys(Game.market.orders).length >= 300) {
            this.cancelZeroRemainingSellOrders();
        }

        var coveragePlan = this.planTerminalCoverage(roomName, resourceType, amount);

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
        creditLedger.commit(creationFee);

        // Schedule local move into terminal (reservation-aware)
        var coverage = this.scheduleTerminalCoverage(roomName, resourceType, coveragePlan);

        // Find the created market order id
        var orderId = this.findOrderId(roomName, resourceType, amount, Game.time);

        // Track this marketSell request. Everything else (price, remaining,
        // reservation state) is derived from Game.market.orders / storageManager.
        var entry = {
            roomName: roomName,
            resourceType: resourceType,
            amount: amount,
            created: Game.time
        };
        if (coverage.tmOpId) entry.tmOpId = coverage.tmOpId;
        if (orderId) entry.orderId = orderId;

        Memory.marketSell.requests.push(entry);
        memoryManager.requestSave();

        var msg = '[MarketSell] Created SELL order from ' + roomName + ': ' + amount + ' ' + resourceType + ' @ ' + finalPrice.toFixed(3);
        if (coverage.need > 0) {
            msg += ' | scheduled to move ' + coverage.need + ' into terminal' + (coverage.tmOpId ? (' (op ' + coverage.tmOpId + ')') : '');
            msg += ' | reservation pending transfer completion';
        } else {
            msg += ' | terminal already has target amount (unreserved: ' + coverage.unreservedInTerminal + ')';
            msg += ' | reservation will be placed on next sync';
        }
        return msg;
    },

    dedupe: function(roomName, resourceType) {
        this.ensureMemory();
        var summary = this.consolidateSellOrders(roomName, resourceType, 0, null);
        return this.formatDedupeSummary(summary);
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

            var matched = false;
            for (var j = 0; j < list.length; j++) {
                var candidate = list[j];
                if (!candidate || candidate.orderId) continue;
                if (candidate.roomName !== order.roomName) continue;
                if (candidate.resourceType !== order.resourceType) continue;
                if (candidate.amount !== orderAmount) continue;

                candidate.orderId = id;
                matched = true;
                attached++;
                break;
            }

            if (!matched) {
                list.push({
                    roomName: order.roomName,
                    resourceType: order.resourceType,
                    amount: orderAmount,
                    created: (typeof order.created === 'number') ? order.created : Game.time,
                    orderId: id
                });
                added++;
            }

            knownOrders[id] = true;
        }

        if (added === 0 && attached === 0) {
            return '[MarketSell] No orphaned marketSell orders found.';
        }

        memoryManager.requestSave();
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
            if (roomSuspender.shouldAvoidRoomWork(agg.roomName)) continue;
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

                activeKeys[k] = true;
            }
        }

        // Unreserve any room+resource combos that are no longer active
        this._unreserveInactive(activeKeys);
    },

    // Check if a request's toTerminal transfer is complete (or wasn't needed)
    _isTransferReady: function(req) {
        // No op ID tracked — transfer wasn't needed, or the op link failed;
        // assume ready (conservative; avoids stuck state)
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
            else if (shortfall > 0) state = 'pending';

            rows.push({
                roomName: r.roomName,
                resourceType: r.resourceType,
                orderTotal: orderTotal,
                orderRemaining: orderRemaining,
                termRsv: termRsv,
                storRsv: storRsv,
                shortfall: shortfall,
                price: (order && typeof order.price === 'number') ? order.price : '-',
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

    // id: a market orderId or a terminalManager op id (tmOpId)
    cancelGather: function(id) {
        this.ensureMemory();
        var list = Memory.marketSell.requests;
        for (var i = list.length - 1; i >= 0; i--) {
            var r = list[i];
            if (r && (r.orderId === id || r.tmOpId === id)) {
                // Cancel the toTerminal op if linked
                if (r.tmOpId && terminalManager && typeof terminalManager.cancelOperation === 'function') {
                    terminalManager.cancelOperation(r.tmOpId);
                }
                list.splice(i, 1);
                memoryManager.requestSave();
                // Sync releases any reservation held for the removed request
                this.syncReservations();
                return '[MarketSell] Cancelled associated local move and removed request: ' + id;
            }
        }
        return '[MarketSell] Request not found (pass an orderId or terminal op id): ' + id;
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
        var attached = 0;

        for (var i = 0; i < list.length; i++) {
            var req = list[i];

            // Migration: strip fields no longer stored (written by old versions)
            delete req.id;
            delete req.price;
            delete req.reserved;
            delete req.needsTransfer;
            delete req.reconciled;

            // 1. Always keep requests created THIS tick
            if (req.created === Game.time) {
                keep.push(req);
                continue;
            }

            // 2. Ensure we have an orderId
            if (!req.orderId) {
                var foundId = this.findOrderId(req.roomName, req.resourceType, req.amount, req.created);
                if (foundId) {
                    req.orderId = foundId;
                    attached++;
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
        if (removed > 0 || attached > 0) memoryManager.requestSave();

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
global.marketSellDedupe = function(roomName, resourceType) {
    return marketSeller.dedupe(roomName, resourceType);
};

module.exports = marketSeller;
