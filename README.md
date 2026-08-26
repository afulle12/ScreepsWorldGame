# Screeps Colony

**Last synchronized: 2026-08-26 — Market Valuation & Spend Guard build**

A multi-room Screeps World AI covering colony economy, logistics, defense, combat, reconnaissance, production, market trading, Power Creeps, and CPU management. `main.js` is the loop entry point and coordinates 119 runtime modules — 36 creep roles under `Bots/`, intelligence and profiling under `Scanners/`, and managers and shared services under `Utilities/` — exposing 424 console globals.

Workflows are deliberately consolidated where they share state or a scarce resource: `Scanners/scanner.js` owns observer scheduling and every intelligence workflow, `Utilities/marketPricing.js` owns all valuation, `Utilities/storageManager.js` and `Utilities/storageVfs.js` own resource reservations, and `Utilities/boostManager.js` owns every boost for every role.

---

## What's New In This Build

### Market valuation and the spend guard

Prompted by an incident on 2026-08-25: two buy orders for 25,000 energy each were posted at **12,555 credits per unit**, roughly a thousand times the market, costing 31M credits in order fees before a single unit arrived. The cause was structural rather than a typo — `getPriceProfile` derives a bid from the ask side alone when the book has no visible bid side, so with one absurd ask standing, the posted bid was one passive step under it. Nothing downstream had an independent opinion about what energy was worth.

**`marketPricing.buyPriceCeiling(resource)`** is now a hard cap on any price the colony will pay, taken as the minimum of independent references, none of which reads the top of book:

| Source | Reference | Cap |
| :--- | :--- | :--- |
| `HISTORY_14D` | volume-weighted **median** daily price over 14 days of `getHistory` | 10× |
| `ASK_DEPTH` | **median** ask across the cheapest `DEPTH_VOLUME` units | 5× |
| `BID_DEPTH` | median competing bid — reported for disagreement, **never caps** | — |

Depth counts as evidence only with at least 3 price levels from 3 distinct rooms and 2,000 units, and the walk outward from the touch stops at the first gap wider than 2×. Real books are bimodal — a tradeable cluster at the touch, a gap, then orders nobody expects to fill, or a wall of fake size parked at 0.03 to catch a mistake — and averaging across that gap prices the wrong half of the book. The bid side never caps because sampled live books show real, unmanipulated bid sides sitting 2×–100× under the traded price; almost everyone lifts asks rather than posting bids. The 14-day median is also a **floor on the ceiling**, so a single depressed source can never silently block legitimate buying.

**`marketSpendGuard.js`** wraps `Game.market.deal` and `Game.market.createOrder` once per tick, before any module can spend, and refuses any buy above the ceiling. Module policy still lives in `marketBuy`; the guard exists so a module that never learned about the ceiling — or one added later — cannot overpay. Blocks land in `Memory.marketGuard`, readable with `marketGuardStatus()`.

### Replacement-cost energy valuation

Energy has two acquisition routes with different economics, no longer conflated:

- **BID** — rest a standing buy order. Freight-free, because whoever fills it calls `deal()` and pays the terminal transfer.
- **DIRECT** — take a live ask now. The colony is the dealer and pays the freight, and for energy that freight is paid *in energy*, out of the same terminal being filled.

`acquisitionQuote(resource)` prices both legs in credits per unit **landed**; `getStatusEnergyPrice()` returns the cheaper one, so every consumer that values energy now uses replacement cost rather than a book price. Freight lands differently by resource, and `deliveredBuyQuote` branches on it: buying energy it comes out of the shipment (`price × take / (take − transferCost)`), buying anything else the full quantity arrives and the energy is a separate credit cost. A `MIN_DELIVERY_YIELD` of 0.5 stops the direct route around 20 rooms out, past which a shipment arrives as a rounding error while the freight is real.

Because an uncrossed book always puts the posted bid under the best ask, **DIRECT can only win on a crossed book** — the normal state of shard3 energy, where distance segments the market and far bidders bid over near asks. Posting and valuation stay separate: `passiveBuyPrice()` is what to post and stays on the bid leg.

### `marketChaos` diagnostics

`marketChaos(count)` samples resources at random and reports both sides of the book, the last three daily prints with standard deviation, the screen price against the 14-day median, the reference's drift from the touch, how much of the near-touch liquidity one room or one price level controls, and how far the independent references disagree — ranked by a composite score with every component shown.

```
  Resource                Chaos   Spread%   vs Hist  Disagree   Room%  Level%   Sd/Avg  state
  XGH2O                      88       n/a   984.73x       n/a     100     100       3%  sellers-only
  wire                       70     155.6       n/a       n/a      33      33      n/a  active
  energy                      8       1.6     1.01x     1.05x      30      30       3%  active
  silicon                  dead       n/a       n/a       n/a     n/a     n/a       7%  empty
```

---

## Runtime Architecture

### Main Loop

`main.js` loads the full CommonJS module set and exports the Screeps loop. Boot order within a tick is deliberate: `memoryManager.run`, budget and economics, room state, defense, towers, links, VFS migration, terminals, scanner, labs, spawning, creeps, VFS maintenance, then scheduler and status work. Errors from loop sections and creep execution are logged with stack traces, sent through `Game.notify`, and retained in a bounded `Memory.errors` history.

Role dispatch happens in `main.js`, but `boostManager.handleCreep(creep)` runs first and can pre-empt it — a `true` return means the creep spent its tick moving to a lab, boosting, or unboosting.

### Adaptive CPU Control

Two wrappers govern every section:

- **`profileSection(name, fn)`** — throttled by tier. CRITICAL runs every tick; HIGH, NORMAL and LOW stretch to 2, 3 and 5 ticks under pressure and may take cost-based minimum intervals of 2, 5 and 10 ticks. Under sustained load they can be deferred up to **10, 25 and 50 ticks**. FLUSH bypasses the cost interval and its late pass may overrun budget by up to 50% of the CPU limit when the bucket allows. Predicted overruns accrue retry debt, and the oldest hard-aged debt may run once per tick — but never at the expense of CRITICAL sections that have not yet run.
- **`measureSection(name, fn)`** — measured, never throttled. For bounded, undeferrable work only.

Every section name must match a `SECTION_TIERS` entry; a missing entry defaults to NORMAL but produces an undefined name hash and can stall under pressure. Modules are classified before being added: CRITICAL (must act every tick and stay bounded), ADAPTIVE (safe after an arbitrary gap, resumes from durable state), SLICED (adaptive, expensive, honors a CPU allowance passed as the callback argument), ALWAYS_RUN (bounded and undeferrable).

The **adaptive contract** is the important part for anyone adding work: never use `Game.time % N` as a correctness gate, because a deferred call can miss that tick forever — persist `lastRun`/`nextRun` and run on the first invocation at or after the due tick. Treat every invocation as overdue. Transactions, spawn requests, construction sites, terminal sends and market actions must be idempotent or guarded by durable pending state written *before* the action. Never assume another module, an observer result, or a cooldown lands on the very next tick.

**`roomSuspender.js`** is the second pressure-control layer: when the bucket is low, eligible low-risk rooms are temporarily suspended while defense, room-state collection, scanning and market systems keep running. Hostiles, military operations, deposits, Power Creeps, structural risk, or bucket recovery prevent or end suspension.

### Memory And Storage

`memoryManager.run()` is the first call each tick. Memory is **heap-backed**: the parsed object is reused across ticks with no per-tick `JSON.parse`, and serialized only at dirty checkpoints (`SAVE_INTERVAL` = 10 ticks) or on an explicit immediate save. The consequence is that a global reset rolls Memory back to the last checkpoint — up to 9 ticks, or 50 for an unmarked mutation.

- `requestSave()` only marks the checkpoint dirty; it must never force same-tick serialization.
- `requestImmediateSave('module.action')` is reserved for mutations paired with an irreversible game action, transaction dedup, FIFO ownership change, or an accounting boundary. The reason string is mandatory.
- Progress, phases, caches, telemetry, history, migrations and retry timers use checkpoints, never immediate saves.
- Transient state belongs in `memoryManager.heap`, which survives ticks, is never serialized, and is empty after a global reset.
- Client Memory-UI edits are clobbered on the next save; run `memoryReload()` first.

**Storage buckets** (`storageBuckets.js` + `flagVault.js`) route data to a backend by policy rather than by hand:

| Bucket | Behavior |
| :--- | :--- |
| `heap` | Recomputable, lost on global reset |
| `serialized` | Memory, under `SAVE_INTERVAL` |
| `flag` | Cold snapshots in flag names, immutable after commit, index in `Memory.flagVault.index`, FIFO eviction of unpinned blocks, at most 20 flags staged per tick because `createFlag` is a 0.2 CPU intent |
| `sign` | Reserved |

Modules register a dataset policy through `require('memoryManager').storage` describing traits — immutable, access pattern, read frequency, recomputable, reset-loss tolerance — and the manager picks the backend. Application code never requires `flagVault` directly. Inspect with `storageOverview()`, `datasetList()`, `datasetInspect(id)`.

**`storageVfs.js`** owns `Memory.storageReservationsV2`, the sole reservation root, with paths like `/rooms/<room>/terminal/<resource>` and ID-mounted `/rooms/<room>/{factory|lab|container|powerSpawn}/<id>/<resource>`. TTLs run from `TTL_NORMAL` 1,000 through `TTL_QUEUED` 2,000 to `TTL_RESERVATION` 100,000, with stale locks aged out at 20,000. Maintenance is bounded at 50 checks per pass, advances a durable cursor, and reports expired versus stale purges separately. Console: `vfsStatus()`, `vfsLs(path)`, `vfsParityReport(room)`, `vfsMigrateLegacy(force)`.

**`permanentRoomFacts.js`** holds immutable controller, source and mineral positions plus a terrain-only 3×3 sector matrix, and encodes that capsule into a checksummed controller sign (`CtrlAltDefeat! | CAD1:<payload><checksum>`) that `roleSignbot` refreshes when missing or obsolete. Foreign signs are never trusted as navigation input.

---

## Learned And Adaptive Systems

### Neural scavenger

Scavenging is driven by a small trained model rather than fixed heuristics, split across two modules.

**`scavengerPolicy.js`** is the decision surface: room eligibility, candidate loot enumeration, spawn decisions, body selection, and pickup decisions, plus the feature extraction (`contextFingerprint`, `candidateFeatures`, `lootFingerprint`) that turns a room and a pile of loot into vectors.

**`scavengerLearning.js`** is the model and its training loop. A 32-dimension context vector and an 8-dimension body-action vector feed small MLPs (hidden sizes 16 and 8) that score candidate actions and candidate bodies. Weights are quantized to 2,048 steps and base64-encoded into a registered storage dataset, so the whole model persists cheaply — dataset version 3, architecture version 1, feature schema version 2.

Training is evolutionary rather than gradient-based:

- An **episode** runs `startOpportunity` → `attachSpawn` → `recordDeposit` → `finalizeEpisode`, capped at 2,000 ticks, with skips resolved explicitly so declining to act is still a labelled outcome.
- **Variants** are produced by mutating the incumbent (rate 0.08, standard deviation 0.05, weights clamped to ±4).
- **Promotion** is deliberately conservative: a challenger must beat the incumbent by a 2% margin across 2 confirmation blocks, with at least 6 samples per variant per room across at least 3 eligible rooms, and **zero invalid outputs**. At most 8 cohorts are pending at once.
- Non-controllable outcomes and execution, path and spawn failures are recorded separately so the model is not credited or blamed for them.

Deployed 2026-08-21. Throughput validation against the previous heuristic is still outstanding.

### Compliance and base building

**`autoBuilder.js`** plans base layouts and places construction sites, blocking exit-adjacent tiles (engine-forbidden) and pre-blocking source, mineral and controller tiles, which are walkable terrain but unbuildable.

**`compliance.js`** audits the empire against its own intended state: spawn-model compliance, room layout, and rampart coverage, with fixes available from the console (`compliance.help()`, `maxEnergyCreeps()`, `roomLayout()`, `fixRampartCompliance()`). `main.js` calls `retireUndersizedHarvesters()` behind a 5,000-tick guard.

---

## Colony Systems

### Spawning And Role Dispatch

`spawnManager.js` is the single spawn orchestrator, running on a 10-tick cadence aligned with Memory serialization — `spawnCreep()` is never called from outside it, and new capability arrives as a `manageXxxSpawns` function. It covers normal populations, emergency harvesting, operation-specific bodies, boosts, one-source layouts, remote missions, repair requests, and military orders. Tower-filler spawning is nested inside `spawnManager.run` behind a 10-tick internal gate rather than existing as its own section.

Dispatch covers 38 role keys against 36 modules, because some runtime names deliberately share an implementation:

- `wallRepair`, `rampartBot`, `defenseRepair` and `repairer` all execute through `Bots/roleRepairer.js`.
- `terminalBot` executes through `Utilities/terminalManager.js`.
- `quad` executes through `Bots/roleSquad.js`.

Role families: core economy (harvester, upgrader, builder, supplier, extractor, mineral collector, maintainer, repairer, scavenger); infrastructure (lab bot, power bot, nuke filler, tower filler, terminal bot, static distributor, extractor assistant, combo bot, HD); remote operations (scout, remote builder, remote supplier, deposit harvester, claimbot, signbot); combat (defender, attacker, harasser, healer, thief, demolition, contested demolisher, drain demolisher, tower drainer, squad/quad, SK attacker, controller attacker); and Power Creeps (operator).

### Defense And Repair

`Scanners/defenseMonitor.js` runs as critical work, tracking hostile entry, defensive-structure damage, weak wall and rampart clusters, incoming nukes, threatened structures, and emergency repair demand.

`towerManager.js` controls attack, heal and repair with cached targets. `repairManager.js` plans peace and war repair priorities, roads and containers, defensive targets, a reconstruction cache, tower repair queues, max-heal behavior, and nuke damage mitigation; its rampart targets and caps are exported through `repairManager.constants` and consumed by `towerManager` and `roleRepairer` rather than redefined.

### Logistics And Infrastructure

- `terminalManager.js` — persistent transfers, storage-to-terminal moves, cooldown and busy-state handling, terminal bots, reservations.
- `linkManager.js` — link energy routing on a three-tick base cadence.
- `roomBalance.js` — periodic inter-room balancing; energy surplus moves before the market is ever consulted.
- `remoteSupplyManager.js` — remote extension-filling and storage-seeding missions.
- `storageManager.js` — the V1 reservation ledger; reserve before moving resources.
- `stockpileManager.js` — strategic stockpile targets, deficits, job trees, transfers and boost requests.
- `energyManager.js` — empire-wide energy distribution and transfer status.
- `roadBuilder.js`, `singleSourceRoom.js`, `localMap.js` — road construction, one-source anchors and layouts, persistent local mapping.
- `claimbotRangeCheck.js` — validates claim routes and range before a claimbot is committed.
- `taskScheduler.js` — persists and re-runs console commands (it evals them), owning `Memory.taskScheduler`.

### Factories, Labs, Boosts, And Power

`factoryManager.js` is a per-room FIFO production manager; use `orderFactory`/`cancelFactoryOrder` rather than bare `factory.produce()`. Output is retained in the factory as a reset witness and batch accounting reconciles from a persisted baseline, so the ready/loadingPending/unloadingPending phases must not be bypassed. `factorySlots.js` bounds concurrent operations per room.

`labManager.js` owns multi-group lab layouts, queued reactions, reagent calculation, reservations, execution, cancellation and watchdog behavior. Worth knowing: **lab reactions consume no energy** — only creep boosting does. `labCommodityRouter.js`, `labReactionPipeline.js` and `labCommodityPolicy.js` handle commodity routing, multi-stage reaction pipelines and reservation policy.

`boostManager.js` owns every boost for every role — role files contain no boost code. Orders name compounds by tier number, compound list, or `{compound: parts}`, and part counts resolve from a pinned order body, else a live creep of that role, else `spawnManager.getCreepBody` at energy capacity. Spawn gating is disabled for roles a room cannot stall on, and military and critical roles stop waiting for a lab after `maxBoostWait` ticks.

`powerManager.js` owns GPL targets, 1,000-power market tranches and a 10-tick PowerSpawn cadence. `roleSupplier` fills PowerSpawns, `roleOperator` owns Power Creeps, and `rolePowerBot` only retires legacy powerbots.

---

## Intelligence And Reconnaissance

`statusReport.js` renders the colony summary — rooms, RCL, energy, creep census, threats, inventory valuation, and the energy market price with its winning acquisition route. `consoleQuery.js` and `cpuQuery.js` expose room-state and CPU inspection, and the opt-in `screeps-profiler.js` is always initialized so `profileFor()` works immediately, at the cost of a small wrapper on registered functions.

`Scanners/scanner.js` consolidates observer scheduling, maintenance scans, room intelligence, player analysis, wide scans, nuke analysis, war estimates, player monitoring, room registry management and energy profiling. It deliberately bypasses the section wrappers and reports its own phase costs.

Visibility is requested through `scanner.observe.request()`; adaptive consumers pass `{ untilConsumed: true, holdTicks: N }`, persist their result, then call `scanner.observe.consume(room, source)` — and the hold must cover the section's hard deferral window. Console requests get the highest priority, followed by war monitoring, deposit route validation, other player monitoring, and background registry sweeps. Powered observers extend range when an assigned Operator has the required power.

Wide scans cover matching rooms within available observer sweep range; they are not a shard-wide census. `roomNavigation.js` is an observer-aware routing helper built on `Game.map.findRoute` with banned-room rules and cached hostile or blocked-room data, not a custom room-level A*. The scanner source is authoritative for scoring weights; `Documentation/IntelWeights.txt` is a historical design reference.

`depositObserver.js` watches configured highway rooms, creates deposit jobs, assigns eligible home rooms, validates routes through the shared observer scheduler, and tracks blocked or temporarily unreachable rooms. `iff.js` is the shared whitelist-aware friend-or-foe authority — combat and scanning code uses it instead of independent username checks. `simscanQuery.js` runs background room simulation scans.

---

## Market And Economy

### Pricing authority

`marketPricing.js` is the single valuation service: order-book profiles, liquidity classification, spread metrics, theoretical recipe-derived valuation for dead markets, conversion quotes, input ceilings, buy-method selection, the corroborated buy ceiling, and delivered acquisition quotes. The book is external-only, dust-filtered at 1,000 remaining units, and rebuilt from a shared `util.marketSnapshot()` with a 30-tick TTL — shared because modules run on staggered tick offsets and would otherwise never hit a per-tick cache. Consumers never add local price formulas or fallbacks; realized averages from our own transaction logs are bookkeeping, not pricing.

`creditLedger.js` tracks in-tick committed spend so several modules trading in the same tick cannot overdraw the balance.

A Screeps quirk shapes every order path: `Game.market.createOrder()` returns `OK` without exposing the new order id, so managers persist pending state before issuing the intent and reconcile against `Game.market.orders` on later ticks.

### Execution

- `marketBuy.js` / `marketSell.js` — managed standing orders with pending capture, reprice-up and reprice-down under fee budgets, tranche sizing, compatible-order extension and duplicate cleanup.
- `marketBatchBuy.js` — one deal per tick against a specific sell order, with terminal capacity, terminal energy and credit checks, and blocking rather than failing when a precondition is missing.
- `opportunisticBuy.js` / `opportunisticSell.js` — immediate-deal evaluation with transaction reconciliation.
- `autoEnergyBuyer.js` — three tiers (normal under 250k storage, emergency under 100k, critical under 50k), comparing the direct and standing-bid routes against battery conversion on acquisition cost. Urgent tiers accept a premium for immediacy; the price-optimal tier does not.
- `marketPriceAdjustment.js` / `marketUpdate.js` — scheduled repricing of live orders, plus one-shot adjustments.

### Production trading

`autoTrader.js` evaluates forward and reverse lab opportunities and factory compression on a base cadence, using a configurable gross-margin threshold with room eligibility checks. `marketArbitrage.js` is a direct-deal spread engine with per-terminal state, transaction-energy accounting on both legs, adaptive scans, exposure limits, order-depth filters, ghost-order cooldowns and credit-ledger integration. `marketLab.js` runs both market-lab directions — buy reagents, stage, combine, sell; or buy compound, stage, break down, sell reagents. `marketRefine.js` handles market-assisted factory conversions and `localRefine.js` the inventory-only equivalent. `marketSpeculator.js` scans and holds speculative positions under a configurable credit cap.

### Accounting

`marketEconomics.js` mints job ids and owns the economic ledger: job lifecycle, profit attribution, lot matching, FIFO cost allocation, and cold-storage archiving of closed jobs. `marketAttribution.js` wraps the market API to record which module incurred each fee, so costs land against the job that caused them. `dailyFinance.js` tracks incoming and outgoing transactions with hourly snapshots and a midnight Pacific reset. `economics.js` ranks per-activity contribution, `inventory.js` reports colony net worth with a 7-day history, and `marketHistory.js` archives daily trade history that `marketConditions.js` turns into volume and momentum views, and `marketSales.js` tracks sell lots for realized-margin accounting.

Reporting and console surfaces are kept separate from the engines that trade: `marketQuery.js`, `marketReport.js`, `marketRoomOrders.js`, `marketMap.js`, `marketAnalysis.js` and `marketChaosQuery.js` read state and render it, so they cost nothing on ticks where no command runs.

---

## Combat And Strategic Operations

- Attackers use persistent orders with spawn room, target room, count and optional mission controls.
- Demolition supports unrestricted targeting plus strict `wall`, `rampart` and `controller` focus modes.
- Contested demolishers use paired units, target modes, cross-sector highway routing, observer verification and persistent operation state.
- Tower drains support route and edge scans, four-position bounce lanes, custom bodies, bulldozers and paired drain-demolisher operations; a drain-demolisher pair adds a dedicated healer position beyond the standard lane.
- Harassers and healers run persistent orders with fire-hold and count controls.
- Thieves use persistent remote-looting orders and shared route intelligence.
- Squads create quad missions; the console order takes formation and attack rooms rather than a unit count.
- Nuker operations cover filling, target analysis through the scanner, and launch sequencing through `nukeLaunch.js`, with status and cancellation.

Route behavior is mission-specific: claimbots accept an explicit room-route array, while deposit, tower-drain, contested-demolisher, thief and scanner workflows use their own planners, cached routes or observer validation.

---

## Diagnostics And Console Operations

424 globals are registered. Each module declares its own in a `// Console globals:` header — that header is authoritative. `help()` prints a curated subset, and `Documentation/ConsoleCommands.md` is the categorized guide.

### Market
    prices()                          // Pricing table for all resources
    priceProfile(RESOURCE_ENERGY)     // State, depth, liquidity, references
    orderBook('ZO')                   // Top 10 bids and asks with rooms and volumes
    marketChaos(5)                    // Sampled book / history / concentration report
    buyCeiling(RESOURCE_ENERGY)       // Ceiling and every evidence source
    marketGuardStatus()               // Blocked buys and the ceilings that stopped them
    compareEnergyCost(100000)         // Energy vs battery, both routes, delivered
    marketVolume(7) / marketMap() / priceDiagnostics()
    autoTrader() / autoTrader('run')
    selling() / buying()              // Optional 'compact'/'expanded' + room filter
    marketBuy('E1N1', 'ZO', 5000) / marketSell('E1N1', 'ZO', 5000)
    marketBuyStatus() / marketSellStatus() / marketBatchBuy(RESOURCE_ENERGY, 50000, 10)
    marketRefine('E1N1', RESOURCE_COMPOSITE) / marketPriceAdjustment('run')
    marketSpeculator('status') / marketEconomicsStatus() / marketHistoryStatus()
    runAutoEnergyBuyer()

### Economy, inventory and storage
    econReport() / invReport() / energyReport()
    financeReport() / fR() / transactionSummary(100)
    stockpileStatus() / stockpileJobs() / stockpileMode(...)
    storageOverview() / datasetList() / datasetInspect(id)
    vfsStatus() / vfsLs() / vfsParityReport() / flagVault('status')

### Intelligence
    intel('W1N1') / intelFast('W1N1') / listIntel()
    registrySweep() / registryStatus() / registryList() / registryPlayer('Name')
    wideScan('Name') / wideScanPlayers() / player('Name') / playerScan('Name', 'CREEPCOUNT')
    warEstimate('Name') / monitor('Name', 'WAR') / monitorStatus()
    maintScan() / maintScanRoom('W1N1') / simScanStart('E1N1')
    nukeAnalyze('W1N1', 3) / nukeIncoming() / nukeThreat('W1N1') / nukeInRange()

### Production and logistics
    orderFactory('W1N1', RESOURCE_COMPOSITE, 'max')
    orderLabs('W1N1', 'XGH2O', 2000) / labForward('W1N1', 'ZO') / labReverse('W1N1', 'ZO')
    labCommodityStatus('E1N1') / localRefineStatus() / showAllProduction()
    transferStuff('E1S1', 'E3S3', RESOURCE_ZYNTHIUM, 5000)
    terminalStatus() / whyTerminal(...) / storageToTerminal(...)
    remoteSupply(...) / listRemoteSupply() / triggerRemoteSupply(...)

### Combat
    orderAttack('E3N44', 'E3N45', 5)
    orderDemolition('E1S1', 'E2S2', 2, 'wall')
    orderContestedDemolisher('E4N49', 'E4N51', 'military')
    orderTowerDrain('E1S1', 'E2S1', 2, 'N') / orderDrainDemolisher(...)
    orderHarass(...) / orderHeal(...) / orderSquad('E1S1', 'W1N1')
    orderSKAttack(...) / orderControllerAttack(...) / orderThieves('W1N1', 'W2N1', 3)
    launchClaimbot('E1S1', 'E3S3', ['E2S1', 'E3S1', 'E3S2', 'E3S3'])
    nukeFill('W1N1', { maxPrice: 1.5 }) / launchNuke('W1N1', 'W3N3', 'spawn')

### Repair, building and compliance
    repairPlan('W1N1') / repairStatus('W1N1') / repairDispatch('W1N1')
    repairNukePlan('W1N1') / repairSetTarget('W1N1', STRUCTURE_RAMPART, 50000000)
    repairCacheBuildings('W1N1') / repairRebuildMissing('W1N1')
    autoBuilder() / buildRoad(...) / removeRoad(...)
    compliance() / compliance.help()

### Power Creeps
    createOperator('C1') / upgradeOperator('C1', PWR_GENERATE_OPS)
    setupOperator('C1', 'E2N46', [PWR_GENERATE_OPS, PWR_OPERATE_FACTORY])
    powerStatus() / powerUpgradeToLevel(25) / freePowerLevels()

### Runtime and diagnostics
    status() / roomState('E1N1', true) / spawnStatus('W1N1') / creepProfile()
    cpu() / cpuHud() / profileRoom('E1S1')
    memoryQuery('rooms.E1N1') / memoryOverview() / memoryProfile() / memoryReload()
    roomSuspendStatus() / roomSuspendPlan() / forceSuspendRoom('E1N1')
    schedule(...) / listScheduled() / runScheduled(...) / help()

---

## Repository Layout

    main.js              Loop entry, scheduler, role dispatch, CPU HUD
    Bots/                36 creep role modules
    Scanners/            scanner, defenseMonitor, depositObserver, iff,
                         creepProfiler, roomCPUProfiler
    Utilities/           Managers and shared services
    docs/                codex.js — the contract read before changing code
    test/                24 dependency-free regression harnesses
    Documentation/       ConsoleCommands.md, HowEverythingWorks, IntelWeights, Notes
    Archive/             Superseded modules kept for reference, never deployed

Screeps loads a flat module set; the folder structure exists for humans, and the uploader must map folders back to flat names such as `require('roleHarvester')`. `docs/`, `test/` and `Documentation/` are not uploaded.

### Working on this codebase

`docs/codex.js` is required reading before changing any runtime module — it records the invariants that are not visible in the code: scheduler contracts, Memory serialization rules, subsystem ownership, market pricing rules, and the API quirks each subsystem works around. `docs/codex-full.js` is the long-form version.

Regression harnesses run under plain Node with no dependencies:

    node test/market_spend_guard_harness.js
    node test/energy_direct_buy_harness.js
    node test/market_lab_queue_harness.js

Syncing from the live Screeps directory is handled by `tools/sync-to-repo.sh` there, which owns the `Bots`/`Scanners`/`Utilities` placement rules and reports any file that has drifted, so the two trees cannot diverge unnoticed.

---

## Removed Or Consolidated Modules

| Previous standalone modules or responsibilities | Active implementation |
| :--- | :--- |
| Room observer, room intel, player analysis, wide scan, nuke analysis, war estimate, player monitoring, maintenance scans | `Scanners/scanner.js` |
| `marketLabForward.js`, `marketLabReverse.js` | `Utilities/marketLab.js` |
| Separate wall, rampart, defense and generic repair executors | `Utilities/repairManager.js` + `Bots/roleRepairer.js` |
| `mineralManager.js` | `Utilities/labCommodityRouter.js`, `marketRefine.js`, `localRefine.js` |
| `globalOrders.js` | Console globals registered by the owning module |
| `memoryProfiler.js` | `Utilities/memoryQuery.js` and runtime telemetry |
| `Documentation/llmcontext.js` | `docs/codex.js` |
| Road tracking helpers | `Utilities/roadBuilder.js` |

Superseded files live under `Archive/` rather than being deleted.

---

## Deployment And Configuration

Deploy the complete module set to one Screeps branch — uploading only `main.js` fails immediately, because it requires the rest at load. Total uploaded size is worth watching: the flat module set is approaching the 5MB branch limit.

Configuration is split across source constants for thresholds and defaults, `Memory.settings` for runtime switches, persistent operation state in Memory for operators, orders, scans, transfers, reservations and scheduled tasks, and console commands for creating and cancelling operations.

| Area | Where |
| :--- | :--- |
| Buy ceiling multipliers, depth gates, delivery yield | `marketPricing.js` (`CEILING_*`, `DELIVERY_MIN_YIELD`) |
| Energy tiers and per-run caps | `autoEnergyBuyer.js` (`TIERS`, `MAX_ENERGY_PER_RUN`) |
| Trading margins and hurdles | `autoTrader.js`, `marketArbitrage.js`, `marketAnalysis.js` |
| Sell floors and exposure caps | `autoTraderSellPolicy.js`, `marketSell.js` |
| CPU tiers and section priorities | `main.js`, `cpuSchedulerPolicy.js` |
| Scavenger model hyperparameters | `scavengerLearning.js` (mutation, promotion, cohort gates) |
| Repair tiers, rampart targets, nuke margins | `repairManager.js` |
| Room scoring, observer priorities, registry cadence | `scanner.js` |
| Storage targets and reservations | `storageManager.js`, `stockpileManager.js`, `storageVfs.js` |
| Room suspension thresholds | `roomSuspender.js` |

Advanced systems need their in-game infrastructure and controller level: terminals, factories, labs, observers, nukers, Power Spawns and Power Creeps. Review room names, allowlists, banned-room rules, price thresholds, reserves and mission routes before deploying to another account or shard.

---

## Contributing

- Read `docs/codex.js` first, and add to it when establishing a new invariant.
- Keep ownership of scarce intents explicit: one manager owns an observer, terminal, spawn, factory, lab group or market workflow at a time.
- Use the shared authorities — `getRoomState`, `storageManager`, `storageVfs`, `marketPricing`, `scanner`, `roomNavigation` — rather than duplicating caches, reservations or price formulas.
- Classify new work as CRITICAL, ADAPTIVE, SLICED or ALWAYS_RUN before adding it to `main.js`, and honor the adaptive contract: no modulo gates, durable cursors, idempotent actions.
- Register console globals in the module that owns the behavior, and document them in `Documentation/ConsoleCommands.md`.
- Add a regression harness for anything that spends credits or changes Memory structure.
- Preserve compatibility role aliases unless their persisted Memory and spawn paths are migrated deliberately.
- Note CPU impact and cadence for new high-frequency work; verify with `cpu()` and `profileRoom()` before and after.
