# Screeps Colony — README

**Version: 2026-08-26 (Market Valuation & Spend Guard Build)**

A multi-room Screeps AI running on shard3. It automates economy, logistics, combat, market trading, production pipelines, and late-game strategy across 119 runtime modules, 36 creep roles, and 424 console commands.

`main.js` sits at the repository root; modules are filed under `Bots/` (creep roles), `Scanners/` (intelligence and profiling), `Utilities/` (everything else), with `docs/`, `test/`, and `Documentation/` alongside.

---

## Latest Update — Market Valuation & Spend Guard

This build reworks how the colony decides what a resource is worth and what it is willing to pay. It was prompted by an incident on 2026-08-25 in which two buy orders for 25,000 energy each were posted at **12,555 credits per unit** — roughly a thousand times the market — costing 31M credits in order fees before a single unit was delivered.

### What caused it

`autoEnergyBuyer` requests energy without a price, so `marketBuy` falls back to the canonical passive bid. That bid came from `getPriceProfile`, which — when the energy book has **no visible bid side** — derives a bid from the ask side alone: one passive step under the only ask standing. With a single absurd ask on the book, the posted bid was one step under it. Nothing downstream disagreed, because nothing downstream had an opinion about what energy was worth.

### The corroborated buy ceiling

`marketPricing.buyPriceCeiling(resource)` is now a hard cap on any price the colony will pay, built from **the minimum of independent evidence sources**, none of which reads the top order:

| Source | Reference | Cap |
| :--- | :--- | :--- |
| `HISTORY_14D` | volume-weighted **median** daily price over 14 days of `getHistory` | 10× |
| `ASK_DEPTH` | **median** ask across the cheapest `DEPTH_VOLUME` units | 5× |
| `BID_DEPTH` | median competing bid — **reported only, never caps** | — |

Depth counts as evidence only with at least 3 price levels from 3 distinct rooms and 2,000 units, and the walk outward from the touch **stops at the first gap wider than 2×**. Real books are bimodal — a tradeable cluster at the touch, a gap, then orders nobody expects to fill (or a wall of fake size parked at 0.03 to catch a mistake) — and averaging across that gap prices the wrong half of the book.

The bid side is deliberately excluded from capping: sampled live books show real, unmanipulated bid sides sitting 2×–100× under the price the same resource actually trades at, because almost everyone lifts asks rather than posting bids. The 14-day median also acts as a **floor on the ceiling** — the colony can always pay what the shard has been paying, so a single depressed source can never silently block legitimate buying.

Above the ceiling the book is not believed at all: `passiveBuyPrice` and `getStatusEnergyPrice` fall back to the binding source's reference (fair value), never to the ceiling itself, since paying the ceiling still means paying 10× on purpose.

### `marketSpendGuard` — a price collar at the API boundary

`marketSpendGuard.js` wraps `Game.market.deal` and `Game.market.createOrder` once per tick, before any module can spend, and refuses any buy above the corroborated ceiling. Module-level policy still lives in `marketBuy`; this exists so a module that never learned about the ceiling — or one added later — cannot overpay because one order on an emptied book said so. Blocks are recorded in `Memory.marketGuard` and readable with `marketGuardStatus()`.

### Replacement-cost energy valuation

Energy has two acquisition routes with different economics, and they are no longer conflated:

- **BID** — rest a standing buy order. Freight-free: whoever fills it calls `deal()` and pays the terminal transfer.
- **DIRECT** — take a live ask now. The colony is the dealer, so it pays the freight — and for energy that freight is paid *in energy*, out of the same terminal being filled.

`acquisitionQuote(resource)` prices both legs in credits per unit **landed** and reports the cheaper one. `getStatusEnergyPrice()` returns that number — replacement cost, not a book price — and it now drives every consumer that values energy: economics, stockpile valuation, scavenger policy, arbitrage, power management, and freight accounting.

Freight lands differently depending on what is bought, and `deliveredBuyQuote` branches on it:

- **Energy**: it comes out of the shipment. `delivered = price × take / (take − transferCost)`, and less arrives than was bought.
- **Everything else**: the full quantity arrives and the energy is a separate credit cost. `delivered = price + transferCost × energyPrice / take`.

A `MIN_DELIVERY_YIELD` of 0.5 stops the direct route at roughly 20 rooms. Past that a shipment arrives as a rounding error while the freight is real — a seller 120 rooms out delivers 457 units for 24,543 burned in transit, and prices out under the ceiling while doing it.

Note the structural consequence: in an uncrossed book the posted bid always sits under the best ask, so **DIRECT can only win when the book is crossed** — which is the normal state of shard3 energy, where distance segments the market and far bidders bid over near asks.

Posting and valuation stay separate: `passiveBuyPrice()` is what to *post* and stays on the bid leg, because the direct route is captured by acting, not by bidding low.

### `marketChaos` — order book diagnostics

`marketChaos(count)` samples resources at random and reports, for each: the competitive end of both sides of the book, the last three daily prints with their standard deviation, the screen price against the 14-day median, how far the volume-weighted reference sits from the touch, how much of the liquidity near the touch one room or one price level controls, and how far the independent references disagree. Results are ranked by a composite chaos score with every component printed, so the score is always auditable.

```
  Resource                Chaos   Spread%   vs Hist  Disagree   Room%  Level%   Sd/Avg  state
  XGH2O                      88       n/a   984.73x       n/a     100     100       3%  sellers-only
  wire                       70     155.6       n/a       n/a      33      33      n/a  active
  energy                      8       1.6     1.01x     1.05x      30      30       3%  active
  silicon                  dead       n/a       n/a       n/a     n/a     n/a       7%  empty
```

Order rows come from the raw snapshot so our own orders (`*`) and sub-dust orders (`.`) stay visible, while every metric is computed from the competing book only.

### Regression coverage

`test/market_spend_guard_harness.js` replays the incident book and asserts the old path reproduces `12555.228` exactly, that the new bid is the history reference, and that both the `createOrder` and the `deal` are refused with nothing reaching the server. `test/energy_direct_buy_harness.js` covers delivered-cost ordering, the yield floor, the urgency premium, insufficient terminal energy, and the energy-versus-commodity freight split.

---

The current tree was synchronized from the active Screeps script branch on 2026-07-10. Related workflows are deliberately consolidated where they share state or scarce resources. For example, `Scanners/scanner.js` owns observer scheduling and intelligence workflows, `Utilities/marketLab.js` owns both forward and reverse market-lab pipelines, and `Bots/roleRepairer.js` executes several repair role aliases.

### Creep Roles (36)

**Harvesting & logistics** — Harvester, Supplier, RemoteSupplier, StaticDistributor, Scavenger, DepositHarvester, MineralCollector, Extractor, ExtractorAssistant

**Construction & maintenance** — Builder, RemoteBuilder, Repairer, Maintainer, Upgrader

**Production** — LabBot (forward and reverse reactions), PowerBot, Operator (Power Creep with modular power priorities)

**Combat & missions** — Attacker, Defender, HD (heavy defense), Healer, Harasser, Squad, SKAttacker, ControllerAttacker, TowerDrain, TowerFiller, Demolition, ContestedDemolisher, DrainDemolisher, Thief, NukeFill

**Support & scouting** — Scout, Signbot, Claimbot, ComboBot

Each role owns its behavior module and declares its dispatch key and console commands in its header. Specialized teams use observer-scanned routing with staged rally logic for multi-room operations.

### Room Intelligence

- **Unified scanner** (`scanner.js`) — observer scheduling, room intel, ownership registry, wide scan, nuke analysis, player analysis, player monitoring, and war estimates in one module with a shared priority queue, so subsystems cannot silently collide on the same observer tick.
- **Room state caching** (`getRoomState.js`) — centralized cached views of structures, creeps, and room metadata.
- **Permanent room facts** (`permanentRoomFacts.js`) — durable per-room truths persisted through the storage VFS.
- **Room navigation** (`roomNavigation.js`) — shared A* room-level pathfinder honoring observer-scanned blocked rooms and ban lists.
- **Local map** (`localMap.js`) — cached local navigation and structure tracking.
- **Simulation scan** (`simscanQuery.js`) — background room simulation scans.

### Market & Economy (33 modules)

- **`marketPricing.js`** — the single pricing authority: order-book profiles, liquidity classification, theoretical recipe-derived valuation, conversion quotes, the corroborated buy ceiling, and delivered/freight-inclusive acquisition quotes. Consumers never hand-roll price formulas.
- **`marketSpendGuard.js`** — pre-trade price collar wrapping the `Game.market` API.
- **`creditLedger.js`** — in-tick committed-spend tracking, so several modules spending in the same tick cannot overdraw.
- **`marketBuy.js` / `marketSell.js`** — managed standing orders with pending-capture reconciliation (`createOrder` returns `OK` without exposing an order id), reprice-up/down with fee budgets, and tranche sizing.
- **`marketBatchBuy.js`** — one-deal-per-tick direct purchases against specific sell orders, with terminal capacity, terminal energy, and credit checks.
- **`opportunisticBuy.js` / `opportunisticSell.js`** — price-triggered purchases and sales with transaction reconciliation.
- **`autoEnergyBuyer.js`** — three-tier energy procurement (normal / emergency / critical) comparing the direct and standing-bid routes against the battery conversion route on acquisition cost.
- **`autoTrader.js`** — production orchestration: opportunity scanning, two-step chains, owned-mineral routing, and commodity residue sweeps.
- **`marketLab.js` / `labCommodityRouter.js` / `labReactionPipeline.js` / `labCommodityPolicy.js`** — lab reaction pipelines, commodity routing, and reservation policy.
- **`marketRefine.js` / `localRefine.js` / `factoryManager.js` / `factorySlots.js`** — factory production cycles, bar compression, and slot allocation.
- **`marketArbitrage.js`** — cross-terminal spread exploitation with freight accounting on both legs.
- **`marketPriceAdjustment.js` / `marketUpdate.js`** — automated and one-shot order repricing.
- **`marketEconomics.js` / `marketAttribution.js`** — job lifecycle, profit attribution, lot matching, and cold-storage archiving; attribution wraps the market API to record which module incurred each fee.
- **`marketHistory.js` / `marketConditions.js`** — daily trade history archiving and volume/momentum analysis.
- **`marketSpeculator.js`** — speculative position scanning and analysis.
- **`marketAnalysis.js` / `marketReport.js` / `marketQuery.js` / `marketMap.js` / `marketChaosQuery.js` / `marketRoomOrders.js`** — profitability tables, reporting, and console diagnostics.
- **`marketSales.js`** — sell-lot tracking for realized-margin accounting.
- **`dailyFinance.js` / `economics.js` / `inventory.js`** — transaction tracking with midnight resets, per-activity contribution ranking, and colony net-worth reporting.

### Storage & Distribution

- **`storageManager.js`** — centralized storage optimization and reservation tracking.
- **`storageVfs.js`** — virtual file system over Memory segments with capacity locks, dataset mounts, and legacy migration.
- **`storageBuckets.js`** — persistent dataset registry across heap, Memory, flags, and signs.
- **`flagVault.js`** — cold storage in flag names for data too large or too cold for Memory.
- **`stockpileManager.js`** — strategic stockpile targets, deficit tracking, and job dispatch.
- **`terminalManager.js` / `roomBalance.js` / `remoteSupplyManager.js`** — terminal transfers, intra-room distribution, and distributed remote supply chains.
- **`energyManager.js`** — empire energy distribution and transfer status.
- **`memoryManager.js`** — serialization scheduling, save-rate tracking, and compaction helpers.
- **`util.js`** — shared primitives every subsystem depends on: the market order snapshot, terminal transfer cost, owned-room lookup, and body cost.

### Infrastructure & Automation

- **`autoBuilder.js`** — automated base layout planning and construction site placement.
- **`repairManager.js` / `roleRepairer.js`** — unified repair planning for roads, containers, walls, ramparts, towers, and nuke-defense prep, with a rebuild cache and spawn-request dispatch.
- **`compliance.js`** — empire-wide room layout and structure compliance auditing.
- **`roomSuspender.js`** — automatic suspension and resumption of underperforming rooms.
- **`spawnManager.js`** — creep and Power Creep spawning with body optimization.
- **`towerManager.js` / `linkManager.js` / `labManager.js` / `powerManager.js`** — tower defense/heal/repair, link routing, multi-group lab reactions, and power spawn support.
- **`boostManager.js`** — boost production, scheduling, and reservation.
- **`scavengerPolicy.js` / `scavengerLearning.js`** — scavenging value model with a learned dataset.
- **`nukeLaunch.js`** — nuke targeting, launch sequencing, and silo readiness.
- **`roadBuilder.js` / `singleSourceRoom.js` / `claimbotRangeCheck.js` / `taskScheduler.js`** — road automation, single-source room tuning, claim route validation, and deferred task execution.

### CPU Management & Diagnostics

- **`main.js`** — explicit CPU budget tiers (CRITICAL / HIGH / NORMAL / LOW) with per-section priorities and a bucket refill target; only CRITICAL sections run every tick under pressure.
- **`cpuSchedulerPolicy.js`** — peak decay and budget policy for the scheduler.
- **`roomCPUProfiler.js` / `creepProfiler.js` / `screeps-profiler.js`** — per-room, per-role, and per-function CPU attribution.
- **`statusReport.js`** — colony status: rooms, RCL, energy, creep census, threats, inventory valuation, and the energy market price with its winning acquisition route.
- **`defenseMonitor.js` / `iff.js`** — real-time threat assessment and friend-or-foe classification.
- **`memoryQuery.js` / `cpuQuery.js` / `consoleQuery.js`** — Memory inspection, CPU breakdowns, and room state queries.

---

### Pricing And Orders

424 console globals are registered. Each module declares its own in a `// Console globals:` header comment — that header is the authoritative list. `help()` prints a curated subset.

### Market — pricing & diagnostics
    prices()                          // Pricing table for all resources
    priceProfile(RESOURCE_ENERGY)     // Full profile: state, depth, liquidity, references
    marketPrice('energy')             // Buy/sell prices for one resource
    orderBook('ZO')                   // Top 10 bids and asks with rooms and volumes
    marketChaos(5)                    // Sampled chaos report: book, history, concentration
    buyCeiling(RESOURCE_ENERGY)       // Corroborated ceiling and every evidence source
    marketGuardStatus()               // Recent blocked buys and the ceilings that stopped them
    marketVolume(7)                   // Daily volume and momentum
    marketMap()                       // Room liquidity snapshot by sector
    priceDiagnostics()                // Audit profiles for anomalies
    conversionQuote(RESOURCE_ENERGY, RESOURCE_BATTERY)
    compareEnergyCost(100000)         // Energy vs battery, both routes, delivered cost

### Market — trading
    autoTrader()                      // Status; autoTrader('run') forces a cycle
    selling() / buying()              // Active orders, optional 'compact'/'expanded' + room
    marketBuy('E1N1', 'ZO', 5000)     // Managed standing buy order
    marketSell('E1N1', 'ZO', 5000)    // Managed standing sell order
    marketBuyStatus() / marketSellStatus()
    marketBatchBuy(RESOURCE_ENERGY, 50000, 10)
    opportunisticBuy(...) / opportunisticSell(...)
    marketRefine('E1N1', RESOURCE_COMPOSITE)
    marketPriceAdjustment('run')      // Reprice active orders
    marketSpeculator('status')
    marketEconomicsStatus()           // Profit, turnover, volume by job
    marketHistoryStatus()             // Archive retention and capacity
    runAutoEnergyBuyer()              // Force an energy procurement cycle

### Economy & inventory
    econReport()                      // Per-activity contribution ranking
    invReport()                       // Net worth, per-resource table, 7-day history
    financeReport() / fR()            // Daily transaction summary
    energyReport()                    // Empire energy distribution
    transactionSummary(100)
    stockpileStatus() / stockpileJobs() / stockpileMode(...)
    storageOverview() / datasetList() / datasetInspect(id)
    vfsStatus() / vfsLs() / vfsParityReport()
    flagVault('status')

### Intelligence & monitoring
    intel('W1N1') / intelFast('W1N1') // Room scoring and analysis
    listIntel() / getCachedIntel('W1N1')
    registrySweep() / registryStatus() / registryList() / registryPlayer('Name')
    wideScan('Name') / wideScanPlayers() / wideScanStatus()
    player('Name') / playerStatus() / playerLast()
    playerScan('Name', 'CREEPCOUNT')
    warEstimate('Name') / warEstimateStatus() / warEstimateLast()
    monitor('Name', 'WAR') / monitorStatus() / monitorPause() / monitorResume()
    maintScan() / maintScanRoom('W1N1')
    simScanStart('E1N1') / simScanStatus()

### Nukes
    nukeAnalyze('W1N1') / nukeAnalyze('W1N1', 3) / nukeAnalyzeSelf()
    nukeIncoming() / nukeThreat('W1N1') / nukeInRange()
    nukeFill('W1N1', { maxPrice: 1.5 })
    launchNuke('W1N1', 'W3N3', 'spawn')

### Production & logistics
    orderFactory('W1N1', 'Composite', 'max')
    orderLabs('W1N1', 'XGH2O', 2000) / labForward(...) / labReverse(...)
    labCommodityStatus('E1N1')
    localRefineStatus() / factoryOrders() / showAllProduction()
    transferStuff('E1S1', 'E3S3', RESOURCE_ZYNTHIUM, 5000)
    remoteSupply(...) / listRemoteSupply() / triggerRemoteSupply(...)
    terminalStatus() / whyTerminal(...) / storageToTerminal(...)

### Combat & missions
    orderAttack('E3N44', 5, 'E3N45')
    orderTowerDrain('E1S1', 'E2S1', 2, 'N')
    orderDemolition('E1S1', 'E2S2', 2, 'wall')
    orderContestedDemolisher('E4N49', 'E4N51')
    orderDrainDemolisher(...) / orderBulldozer(...)
    orderHarass(...) / orderHeal(...) / orderSquad(...)
    orderSKAttack(...) / orderControllerAttack(...)
    orderThieves('W1N1', 'W2N1', 3) / listThiefOrders()
    launchClaimbot('E1S1', 'E3S3', ['E2S3', 'E3S3'])

### Repair & building
    repairPlan('W1N1') / repairStatus('W1N1') / repairDispatch('W1N1')
    repairNukePlan('W1N1') / repairSetTarget('W1N1', STRUCTURE_RAMPART, 50000000)
    repairPause('W1N1') / repairResume('W1N1')
    repairCacheBuildings('W1N1') / repairRebuildMissing('W1N1')
    autoBuilder() / buildRoad(...) / removeRoad(...)
    compliance() / compliance.help()

### Power Creeps
    createOperator('C1') / upgradeOperator('C1', PWR_GENERATE_OPS)
    setupOperator('C1', 'E2N46', [PWR_GENERATE_OPS, PWR_OPERATE_FACTORY])
    powerStatus() / powerUpgradeToLevel(25) / freePowerLevels()

### Status & diagnostics
    status()                          // Full colony status report
    roomState('E1N1', true) / printRoomState('E1N1')
    spawnStatus('W1N1') / creepProfile()
    cpu() / cpuHud() / cpuHelp() / profileRoom('E1S1')
    memoryQuery('rooms.E1N1') / memoryOverview() / memoryProfile()
    roomSuspendStatus() / roomSuspendPlan() / getSuspendedRooms()
    schedule(...) / listScheduled() / runScheduled(...)
    help()

---

## Repository Layout

    main.js              Main loop, CPU scheduler, section priorities
    Bots/                36 creep role modules
    Scanners/            scanner, iff, depositObserver, creepProfiler, roomCPUProfiler
    Utilities/           All managers, market modules, storage, diagnostics
    docs/                codex.js — the module contract read before changing code
    test/                24 dependency-free regression harnesses
    Documentation/       HowEverythingWorks, IntelWeights, Notes
    Archive/             Superseded modules kept for reference, not deployed

Screeps loads only the flat set of modules; the folder structure exists for humans. `docs/` and `test/` are not uploaded.

### Working on this codebase

Read `docs/codex.js` before changing any runtime module — it records the invariants that are not obvious from the code, including market pricing rules, Memory serialization contracts, and the API quirks each subsystem works around. `docs/codex-full.js` holds the long-form version.

Run the regression harnesses with plain Node, no dependencies required:

    node test/market_spend_guard_harness.js
    node test/energy_direct_buy_harness.js
    node test/market_lab_queue_harness.js

Syncing from the live Screeps directory into this repository is handled by `tools/sync-to-repo.sh` there, which owns the `Bots`/`Scanners`/`Utilities` placement rules so the two trees cannot silently drift.

---

`dailyFinance.js` tracks incoming and outgoing transactions, hourly snapshots, and daily reports with a midnight Pacific Time reset.

| Area | Where |
| :--- | :--- |
| Buy ceiling multipliers, depth gates, delivery yield | `marketPricing.js` (`CEILING_*`, `DELIVERY_MIN_YIELD`) |
| Energy tier thresholds and buy amounts | `autoEnergyBuyer.js` (`TIERS`, `MAX_ENERGY_PER_RUN`) |
| Trading margins and hurdles | `autoTrader.js`, `marketArbitrage.js`, `marketAnalysis.js` |
| Sell floors and exposure caps | `autoTraderSellPolicy.js`, `marketSell.js` |
| CPU budget tiers and section priorities | `main.js`, `cpuSchedulerPolicy.js` |
| Repair tiers, rampart targets, nuke margins | `repairManager.js` |
| Room scoring, observer priorities, registry cadence | `scanner.js`, `Documentation/IntelWeights.txt` |
| Storage targets and reservations | `storageManager.js`, `stockpileManager.js` |
| Room suspension thresholds | `roomSuspender.js` |

---

## Architecture Notes

- **Single authorities.** One module owns each shared concern — `marketPricing` for valuation, `getRoomState` for room views, `storageManager` for reservations, `roomNavigation` for inter-room paths. Consumers do not reimplement them.
- **Caching by snapshot, not by tick.** Market data is keyed to a shared order snapshot with a TTL, because modules run on staggered tick offsets and would otherwise never share a per-tick cache.
- **Memory is expensive.** Serialization cost is sampled and amortized into the CPU scheduler's reserve; cold data moves to Memory segments through `storageVfs` or into flag names through `flagVault`.
- **Fail closed on money.** Pricing paths refuse to act on uncorroborated data rather than guessing, and a pre-trade guard sits between every module and the market API.
- **Console-first operations.** Nearly every subsystem exposes status and control commands, so tuning and diagnosis happen live rather than through redeploys.

## Contributing

- Read `docs/codex.js` first; add to it when establishing a new invariant.
- Keep one concern per module, and register console globals in the module that owns the behavior.
- Use the shared authorities rather than duplicating their logic.
- Add a regression harness for anything that spends credits or mutates Memory structure.
- Note CPU impact for new hot-path loops, and profile with `profileRoom` / `cpu()` before and after.
