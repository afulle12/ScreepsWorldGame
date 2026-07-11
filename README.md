# Screeps Colony

Last synchronized: 2026-07-10

## Overview

This repository contains a multi-room Screeps World AI for colony economy, logistics, defense, combat, reconnaissance, production, market trading, Power Creeps, and CPU management. `main.js` is the loop entry point and coordinates the modules under `Bots/`, `Scanners/`, and `Utilities/`.

The current tree was synchronized from the active Screeps script branch on 2026-07-10. Related workflows are deliberately consolidated where they share state or scarce resources. For example, `Scanners/scanner.js` owns observer scheduling and intelligence workflows, `Utilities/marketLab.js` owns both forward and reverse market-lab pipelines, and `Bots/roleRepairer.js` executes several repair role aliases.

## Runtime Architecture

### Main Loop

`main.js` loads the complete CommonJS module set and exports the Screeps loop. A tick broadly performs the following work:

1. Restore the retained heap-backed Memory object.
2. Calculate the CPU budget and scheduler pressure.
3. Refresh profiling caches, statistics, and room-state data.
4. Plan room suspension and claim-range checks.
5. Run critical defense, tower, repair, and link work.
6. Run infrastructure, production, logistics, market, and scanner state machines.
7. Spawn and execute normal creeps and configured Power Creeps.
8. Run profiling, scheduled tasks, reports, mapping, and CPU telemetry.

Errors from loop sections and creep execution are logged with stack traces, sent through `Game.notify`, and retained in a bounded `Memory.errors` history.

### Memory And Shared State

`Utilities/memoryManager.js` retains the parsed Memory object on the JavaScript heap and serializes it every 10 ticks or after an explicit save request. This reduces routine parse/stringify cost, but a global reset can lose changes made since the last serialized save. External edits made directly through the Memory editor are not automatically reloaded into the retained object.

`Utilities/getRoomState.js` is the shared live-state service. It builds per-tick indexes for owned rooms and visible rooms containing the player's creeps or Power Creeps. Structures, sources, minerals, ruins, tombstones, dropped resources, construction sites, creeps, and hostiles use category-specific cache lifetimes. Callers must use ownership helpers rather than assuming every cached room is owned.

`Utilities/storageManager.js` is the shared resource-reservation ledger. Labs, factories, terminals, and market systems use reservations to avoid committing the same inventory to multiple operations.

### Adaptive CPU Control

The loop is tuned around a 20-CPU environment and adjusts its target budget from the CPU bucket:

| Bucket | Scheduler tier | Target budget |
| --- | --- | --- |
| Below 1,000 | Critical | 14 CPU |
| 1,000-2,999 | Low | Interpolated from 14 to 18 CPU |
| 3,000-7,999 | Normal | 18 CPU |
| 8,000 or higher | Flush | 19.3 CPU |

Memory-save ticks reserve additional CPU for serialization. Work is divided into critical, high, normal, and low importance bands. Critical work runs every tick; lower bands are deterministically staggered as pressure increases. Creep execution has a separate role-priority throttle, with critical economy and defense roles running more frequently than optional or background roles.

`Utilities/roomSuspender.js` provides a second pressure-control layer. When the bucket is low, eligible low-risk rooms can be temporarily suspended while defense, room-state collection, scanning, and market systems remain active. Hostiles, military operations, deposits, Power Creeps, structural risk, and bucket recovery prevent or end suspension.

CPU tools include per-role telemetry, per-module telemetry, a room CPU profiler, creep profiling, a RoomVisual HUD, and the opt-in `screeps-profiler`. Profiler wrapping is selected at global initialization, so `profilerOn()` and `profilerOff()` require a global reset to take full effect.

## Colony Systems

### Spawning And Creeps

`Utilities/spawnManager.js` is the central spawn orchestrator and runs on a 10-tick cadence aligned with Memory serialization. It handles normal colony populations, emergency harvesting, operation-specific bodies, boosts, specialized one-source layouts, remote missions, repair requests, and military orders.

The active runtime dispatches these role families:

- Core economy: harvester, upgrader, builder, supplier, extractor, mineral collector, maintainer, and repairer.
- Infrastructure: lab bot, power bot, nuker filler, tower filler, terminal bot, static distributor, extractor assistant, and combo bot.
- Remote operations: scout, remote builder, remote supplier, deposit harvester, claimbot, and signbot.
- Combat: defender, attacker, thief, demolition, contested demolisher, drain demolisher, tower drainer, bulldozer variants, squad/quad, Source Keeper attacker, and controller attacker.
- Specialized layouts: HD stationary harvester/distributor and combo-bot workflows for one-source RCL 8 rooms.
- Power Creeps: Operator lifecycle and configured power priorities are handled separately from normal creeps.

Most roles have a dedicated module under `Bots/`. Some runtime role names intentionally share implementations:

- `wallRepair`, `rampartBot`, `defenseRepair`, and `repairer` execute through `Bots/roleRepairer.js`.
- `terminalBot` executes through `Utilities/terminalManager.js`.
- Tower-drain operation units are coordinated by `Bots/roleTowerDrain.js`, with drain-demolisher behavior in `Bots/roleDrainDemolisher.js`.

### Defense And Repair

`Scanners/defenseMonitor.js` runs as critical work and tracks hostile entry, defensive-structure damage, weak wall/rampart clusters, incoming nukes, threatened structures, notifications, and emergency repair demand.

`Utilities/towerManager.js` controls tower attacks, healing, and selected repair work using cached targets. `Utilities/repairManager.js` plans peace and war repair priorities, road and container maintenance, defensive targets, reconstruction caches, tower repair queues, max-heal behavior, and nuke damage mitigation. `Bots/roleRepairer.js` consumes those plans for generic, wall, rampart, and emergency-defense repair roles.

The repair migration retains compatibility role names and some legacy constants, but repair planning and execution are centered on `repairManager` and `roleRepairer`.

### Logistics And Infrastructure

- `terminalManager.js` owns persistent transfers, local storage-to-terminal moves, terminal cooldown handling, busy-state decisions, terminal bots, and resource reservations.
- `linkManager.js` routes link energy on a three-tick base cadence.
- `roomBalance.js` periodically balances selected resources between rooms.
- `remoteSupplyManager.js` creates and tracks remote extension-filling and storage-seeding missions.
- `storageManager.js` owns reservations and reports unreserved stock.
- `roadBuilder.js` provides console-driven road construction and removal.
- `singleSourceRoom.js` manages anchors and specialized one-source layouts.
- `localMap.js` performs persistent local mapping work.

### Factories, Labs, Boosts, And Power

`Utilities/factoryManager.js` is a per-room FIFO production manager. Rooms can process orders concurrently. Factory operations validate recipes and available inputs, while suppliers and specialized stationary bots move inputs and outputs. Commodity recipes, mineral compression, and decompression workflows are supported.

`Utilities/labManager.js` owns multi-group lab layouts, queued reactions, reagent calculation, reservations, reaction execution, cancellation, watchdog behavior, and lab-bot staging. `Bots/roleLabBot.js` performs physical lab logistics and supports normal reactions and reverse reactions.

`Utilities/boostManager.js` separately owns boost orders, lab preparation, creep boost state, cancellation, and status reporting. Boost and production lab state are coordinated but remain distinct systems.

`Utilities/powerManager.js` handles Power Spawn processing for owned rooms. `Bots/roleOperator.js` manages Operator creation, assignment, spawning, renewal, and configurable power priorities, including powered observer support.

## Intelligence And Reconnaissance

### Unified Scanner

`Scanners/scanner.js` consolidates observer scheduling, maintenance scans, room intelligence, player analysis, wide scans, nuke analysis, war estimates, player monitoring, room registry management, and energy profiling.

Full room intelligence currently scores four categories:

- Economic: 20%
- Military: 25%
- Infrastructure: 30%
- Operational efficiency: 25%

Fast intelligence uses a reduced three-category model. The scanner source is authoritative for individual weights and classification thresholds; `Documentation/IntelWeights.txt` is retained as a historical design reference and may describe the previous scoring model.

The observer scheduler centrally books observer use so multiple systems do not issue competing intents in the same tick. Console requests receive the highest priority, followed by war monitoring, deposit route validation, other player monitoring, and background registry sweeps. Powered observers can extend supported scanning workflows when an assigned Operator has the required power.

Wide scans cover matching rooms within available observer sweep range; they are not a guaranteed shard-wide census. `Utilities/roomNavigation.js` is an observer-aware room routing helper built around `Game.map.findRoute`, banned-room rules, and cached hostile or blocked-room data. It is not a custom room-level A* implementation.

### Deposits And IFF

`Scanners/depositObserver.js` watches configured highway rooms, creates deposit jobs, assigns eligible home rooms, validates routes through the unified observer scheduler, and tracks blocked or temporarily unreachable rooms. Deposit harvesters follow an authoritative route, harvest until full or finished, return home, deliver, and retire.

`Scanners/iff.js` is the shared whitelist-aware friend-or-foe authority. Combat and scanning code should use it instead of performing independent username checks.

## Market And Economy

### Pricing And Orders

`Utilities/marketPricing.js` is the shared valuation service for weighted prices, bid/ask depth, spread, history, effective transaction prices, input ceilings, and buy-method selection. It uses a shared per-tick market snapshot, excludes the player's own orders from public valuation, and filters very small orders.

Routine market operations are separated by responsibility:

- `marketBuy.js` manages posted buy workflows and reconciliation.
- `marketSell.js` manages dynamic and fixed sell orders, compatible-order extension, bulk selling, and duplicate cleanup.
- `marketUpdate.js` reprices managed orders.
- `marketRoomOrders.js`, `marketQuery.js`, and `marketReport.js` provide order and transaction reporting.
- `opportunisticBuy.js` and `opportunisticSell.js` evaluate immediate deals every 10 ticks.
- `creditLedger.js` tracks credit reservations used by concurrent market operations.

Screeps does not synchronously return a new order ID from `Game.market.createOrder()`. Market managers therefore retain pending state and reconcile against `Game.market.orders` on later ticks.

### Automated Trading

`Utilities/autoTrader.js` evaluates forward and reverse lab opportunities plus factory compression workflows on a 100-tick base cadence. It uses a configurable gross-margin threshold and room eligibility checks. Its opportunity model deliberately relies on margin buffers rather than applying the arbitrage engine's full transaction-energy calculation to every estimate. Factory decompression analysis and workflow support exist, but automatic decompression scheduling is disabled by default.

`Utilities/marketArbitrage.js` is a direct-deal spread engine with per-terminal state, transaction-energy accounting on both legs, adaptive scans, exposure limits, order-depth filters, ghost-order cooldowns, buffered inventory, grouped terminal operations, and credit-ledger integration.

`Utilities/marketLab.js` consolidates both market-lab directions:

- Forward: buy reagents, stage labs, combine, and sell the compound.
- Reverse: buy a compound, stage labs, break it down, and sell the reagents.

`marketRefine.js` manages market-assisted factory conversions, while `localRefine.js` uses local inventory. `mineralManager.js` manages extraction, hauling, compressed bars, periodic highway-resource disposition, and reservation-aware selling. `autoEnergyBuyer.js` checks eligible rooms every 1,050 ticks rather than continuously.

`dailyFinance.js` tracks incoming and outgoing transactions, hourly snapshots, and daily reports with a midnight Pacific Time reset.

## Combat And Strategic Operations

- Attackers use persistent orders with spawn room, target room, count, and optional mission controls.
- Standard demolition supports unrestricted targeting plus strict `wall`, `rampart`, and `controller` focus modes.
- Contested demolishers use paired units, target modes, cross-sector highway routing, observer verification, and persistent operation states.
- Tower drains support route and edge scans, standard four-position bounce lanes, custom bodies, bulldozers, and paired drain-demolisher operations. A drain-demolisher pair adds a dedicated healer position beyond the standard drain lane.
- Thieves use persistent remote-looting orders and shared route intelligence.
- Squads create quad missions; their console order accepts formation and attack rooms rather than a unit count.
- Controller attackers, Source Keeper attackers, claimbots, remote builders, signbots, and remote suppliers have dedicated order workflows.
- Nuker operations include filling, target analysis through the scanner, launching, status tracking, and cancellation.

Route behavior is mission-specific. Claimbots can receive an explicit room-route array. Deposit, tower-drain, contested-demolisher, thief, and scanner workflows use their own route planners, cached route data, or observer validation.

## Diagnostics And Console Operations

The runtime installs console globals for:

- Combat, demolition, tower drains, thieves, squads, claiming, signing, SK attacks, and remote missions.
- Factory, lab, boost, terminal, storage, transfer, repair, and Power Creep operations.
- Market orders, pricing, analysis, arbitrage, refining, finance, and automated trading.
- Room intelligence, player scans, monitoring, registry sweeps, war estimates, nuke analysis, and deposit operations.
- Memory queries, CPU reports, profiling, room suspension, scheduled commands, anchors, roads, and local maps.

Selected valid examples:

```js
orderAttack('E3N44', 'E3N45', 5)
orderDemolition('E1S1', 'E2S2', 2, 'wall')
orderContestedDemolisher('E4N49', 'E4N51', 'military')
orderTowerDrain('E1S1', 'E2S1', 2, 'N')
orderSquad('E1S1', 'W1N1')
launchClaimbot('E1S1', 'E3S3', ['E2S1', 'E3S1', 'E3S2', 'E3S3'])

orderFactory('W1N1', RESOURCE_COMPOSITE, 'max')
orderLabs('W1N1', 'XGH2O', 2000)
labForward('W1N1', 'ZO')
labReverse('W1N1', 'ZO')
transferStuff('E1S1', 'E3S3', RESOURCE_ZYNTHIUM, 5000)

prices('energy')
console.log(marketAnalysis())
console.log(orderBook('ZO'))
financeReport('compact')

intel('W1N1')
wideScan('PlayerName')
player('PlayerName')
warEstimate('PlayerName')
roomState('W1N1', true)
memoryOverview()
cpu()
```

See `Documentation/ConsoleCommands.md` for the categorized command guide. Module source remains authoritative for optional arguments, advanced controls, and newly added globals.

## Repository Layout

### Root

- `main.js`: loop entry point, scheduler, creep dispatcher, profiling, and subsystem orchestration.
- `README.md`: current architecture and operation overview.

### Bots

`Bots/` contains 33 active role modules:

- Economy and infrastructure: `roleHarvester`, `roleUpgrader`, `roleBuilder`, `roleSupplier`, `roleExtractor`, `roleExtractorAssistant`, `roleMineralCollector`, `roleMaintainer`, `roleRepairer`, `roleLabBot`, `rolePowerBot`, `roleNukeFill`, `roleTowerFiller`, `roleStaticDistributor`, `roleHD`, and `roleComboBot`.
- Remote and support: `roleScout`, `roleClaimbot`, `roleRemoteBuilder`, `roleRemoteSupplier`, `roleDepositHarvester`, and `roleSignbot`.
- Combat and strategy: `roleDefender`, `roleAttacker`, `roleThief`, `roleDemolition`, `roleContestedDemolisher`, `roleDrainDemolisher`, `roleTowerDrain`, `roleSquad`, `roleSKAttacker`, and `roleControllerAttacker`.
- Power Creeps: `roleOperator`.

### Scanners

- `scanner.js`: unified observers, intelligence, registry, monitoring, nuke analysis, war estimates, and energy profiling.
- `depositObserver.js`: highway deposit discovery and job planning.
- `defenseMonitor.js`: hostile, defensive-structure, and nuke threat monitoring.
- `iff.js`: shared friend-or-foe checks.
- `creepProfiler.js`: creep execution profiling and reports.
- `roomCPUProfiler.js`: room-oriented CPU profiling and HUD support.

### Utilities

`Utilities/` contains the managers and shared services. Major groups include:

- Runtime and CPU: `memoryManager`, `getRoomState`, `roomSuspender`, `taskScheduler`, `cpuQuery`, `consoleQuery`, `screeps-profiler`, and `statusReport`.
- Colony infrastructure: `spawnManager`, `towerManager`, `repairManager`, `linkManager`, `terminalManager`, `storageManager`, `roomBalance`, `remoteSupplyManager`, `roadBuilder`, `roomNavigation`, `singleSourceRoom`, and `localMap`.
- Production: `factoryManager`, `labManager`, `boostManager`, `powerManager`, and `mineralManager`.
- Market and finance: `marketPricing`, `marketAnalysis`, `marketBuy`, `marketSell`, `marketUpdate`, `marketRoomOrders`, `marketQuery`, `marketReport`, `marketMap`, `marketArbitrage`, `marketLab`, `marketRefine`, `localRefine`, `autoTrader`, `autoEnergyBuyer`, `opportunisticBuy`, `opportunisticSell`, `dailyFinance`, and `creditLedger`.
- Strategy and support: `nukeLaunch`, `claimbotRangeCheck`, `memoryQuery`, `util`, and `llmcontext`.

## Removed Or Consolidated Modules

The 2026-07-10 synchronization removed repository-only JavaScript that was absent from the active Screeps branch. Important consolidations include:

| Previous standalone modules or responsibilities | Active implementation |
| --- | --- |
| Room observer, room intel, player analysis, wide scan, nuke analysis, war estimate, player monitoring, and maintenance scans | `Scanners/scanner.js` |
| `marketLabForward.js` and `marketLabReverse.js` | `Utilities/marketLab.js` |
| Separate wall, rampart, defense, and generic repair executors | `Utilities/repairManager.js` and `Bots/roleRepairer.js` |
| Memory-size profiling and queries | `Utilities/memoryQuery.js`, CPU tools, and runtime telemetry |
| Road tracking/build helpers | `Utilities/roadBuilder.js` |

Legacy repository files such as `roleFactoryBot.js`, `roleRemoteHarvesters.js`, `roleRepairBot.js`, `roleScavenger.js`, `roleWallRepair.js`, `squadModule.js`, `globalOrders.js`, `nukeUtils.js`, and standalone scanner components were deleted because no matching deployed source file remained. The active `Bots/roleSquad.js` was retained and is the current squad implementation.

## Deployment And Configuration

Deploy the complete JavaScript module set to one Screeps branch; deploying only `main.js` will fail because it immediately requires the other modules. The runtime uses flat Screeps module names such as `require('roleHarvester')` and `require('scanner')`, so the uploader or synchronization method must map files from the repository folders to those branch module names.

Configuration is split across:

- Source constants for thresholds and system defaults.
- `Memory.settings` for runtime switches such as profiler state.
- Persistent operation state in Memory for operators, orders, scans, transfers, reservations, and scheduled tasks.
- Console commands for creating, inspecting, modifying, and cancelling operations.

Advanced systems require their corresponding in-game infrastructure and controller level, including terminals, factories, labs, observers, nukers, Power Spawns, and Power Creeps. Review room names, allowlists, banned-room rules, price thresholds, reserves, and mission routes before deploying to another account or shard.

## Documentation

- `Documentation/ConsoleCommands.md`: categorized console command guide.
- `Documentation/IntelWeights.txt`: historical intelligence-weight design notes; current weights live in `Scanners/scanner.js`.
- Other files under `Documentation/`: historical notes and design references; they are not deployed JavaScript modules.

## Contributing

- Keep ownership of scarce intents explicit: one manager should own an observer, terminal, spawn, factory, lab group, or market workflow at a time.
- Use `getRoomState`, `storageManager`, `marketPricing`, `scanner`, and shared navigation helpers rather than duplicating caches or reservations.
- Preserve compatibility role aliases unless their persisted Memory and spawn paths are migrated deliberately.
- Document new console globals in `Documentation/ConsoleCommands.md` and update this README when architecture changes.
- Include CPU impact and cadence notes for new high-frequency work.
- Run JavaScript syntax checks and verify module-name mappings before deployment.
