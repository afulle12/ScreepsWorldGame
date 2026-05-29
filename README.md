# Screeps Colony – README
Version: 2026-05-28 (Expanded Build)

## Overview

This repository runs a comprehensive multi-room Screeps AI that automates economy, logistics, combat, market play, and late-game strategy. The codebase is heavily modular: each subsystem lives in its own module and is orchestrated from the main loop. The latest build significantly expands specialized creep roles (tower fillers, combo bots, SK attackers, rampart bots, and more), adds dedicated profiling and monitoring systems for CPU/energy/creeps, introduces advanced defense and strategic monitoring, and provides distributed remote supply management alongside core systems.

## Core Systems

### Creep & Squad Roles

**Base Roles:**
- Harvesters
- Upgraders
- Builders
- Suppliers / Haulers
- Scouts
- Defenders
- Attackers
- Signers
- Wall Repair
- Scavengers
- Repair Bots
- Maintainers

**Specialized Roles:**
- Thieves (with order system and observer-scanned routing)
- Tower Drainers (full 4-position bounce mechanic with route scanning)
- Tower Fillers (dedicated tower energy supply; new)
- Demolition teams (with wall-only focus mode)
- Contested Demolishers (paired demolisher system for hostile rooms)
- Combo Bots (multi-purpose flexible creeps; new)
- HD (Heavy Defense; new)

**Resource Extraction & Processing:**
- Mineral Collectors
- Extractors
- Extractor Assistants (dedicated support creeps; new)
- Factory Bots
- Lab Bots (forward and reverse reaction support)
- Power Bots (with low-TTL resource recovery)
- Deposit Harvesters (highway deposit collection)

**Remote & Specialized Operations:**
- Claimbots (with hardcoded route support)
- Remote Builders
- Remote Harvesters
- Remote Suppliers (distributed remote supply management; new)
- Rampart Bots (dedicated rampart construction and reinforcement; new)
- Static Distributors (fixed-position resource distribution; new)
- SK Attackers (Source Keeper combat specialists; new)
- Controller Attackers (controller downgrade operations; new)

**Advanced:**
- Power Creeps / Operators (with modular power priorities)
- Squad members and multi-creep mission roles
- Nuke Fillers

Each role owns its behavior module, with spawn bodies tuned for distance, TTL, or mission needs. Specialized teams (tower drainers, demolition, contested demolishers, thieves) use observer-scanned routing and staged/rally logic for multi-room operations.

### Infrastructure & Room Intelligence

- **Room state caching**: Centralized, cached views of structures, creeps, and key room metadata.
- **Room intelligence scoring**: Weighted analysis of rooms across Economic (25%), Military (30%), and Dual Purpose (45%) categories with auto-expiring caches.
- **Observer scanning**: Scheduled room visibility sweeps with fallback chain (structural observer → Operator with PWR_OPERATE_OBSERVER → manual scouting).
- **Wide scan**: Full observer-range sweep to find all rooms owned by a target player.
- **Player analysis**: Multi-phase intelligence pipeline (wideScan → roomIntel → comprehensive report with strength classifications, aggregated scores, and nuke capability comparison).
- **Room navigation**: Shared A* room-level pathfinder respecting observer-scanned blocked rooms and custom ban lists.
- **Managers**:
  - Link routing and energy distribution
  - Terminal balancing and transfers
  - Towers (streamlined cached-target defense/heal/repair)
  - Factory production order handling (with COMMODITIES fallback for advanced recipes)
  - Lab reaction workflows (multi-group edition with order queuing)
  - Power spawn support
  - Power Creep (Operator) lifecycle management

### Profiling & Diagnostics Systems (New)

- **Creep Profiler** (`creepProfiler.js`): Real-time per-creep role statistics, spawn efficiency tracking, and performance analysis.
- **Energy Profiler** (`energyProfiler.js`): Room-level energy flow analysis, production/consumption metrics, and efficiency reporting.
- **Room CPU Profiler** (`roomCPUProfiler.js`): CPU cost tracking per room, per subsystem, with performance trending and bottleneck identification.
- **CPU optimization patterns**:
  - Cached state reads and per-tick caches
  - Throttled/staged execution
  - Reduced per-tick recalculation where possible
  - Lookup tables and assignment caching in hot-path roles
  - Memory path cleanup on idle creeps
- **Memory query utility** for deep recursive search through Memory.
- **Console API** for live control, debugging, and scheduling without redeploying code.
- **Wall/rampart progress tracking** with ETA calculations.
- **Daily financial reporting**.

### Defense & War Monitoring (New)

- **Defense Monitor** (`defenseMonitor.js`): Real-time threat assessment, tower status, hostile creep tracking, and automatic escalation alerts.
- **War Estimate** (`warEstimate.js`): Strategic strength analysis, combat capability prediction, casualty estimation, and battle outcome forecasting.
- **Player Monitor** (`playerMonitor.js`): Ongoing surveillance of target players, activity tracking, expansion monitoring, and attack pattern analysis.
- **Nuke Analysis** (`nukeAnalyze.js`): Nuke landing prediction, incoming nuke detection, damage forecasting, and defensive counter-strategy.

### Resource & Market Automation

- **Automated trading**: Periodic analysis and execution of profitable reverse reactions and factory compression jobs with configurable margin thresholds.
- **Market arbitrage**: Buy-sell spread exploitation with per-terminal state machines and full energy cost accounting on both transaction legs.
- **Lab pipelines**: Dedicated forward (buy reagents → combine → sell compound) and reverse (buy compound → break down → sell reagents) operation managers supporting concurrent operations per room.
- **Market Lab** (`marketLab.js`): Unified lab reaction profit analysis and automated pipeline orchestration.
- **Centralized pricing**: Weighted Mid-Price calculation across all resources for consistent valuation.
- **Daily finance tracking**: Transaction monitoring with midnight resets, hourly snapshots, and report generation.
- **Market analysis**: Comprehensive profitability tables for factory production, factory decompression, lab production, and reverse reactions with price source tracking (LIVE/HIST/MBUY), actionable indicators, and order depth warnings.
- **Auto energy buying**: Automatic energy purchases when room storage falls below configurable thresholds.
- **Opportunistic market actions**: Buyer/Seller workflows for routine trading and market opportunities.
- **Opportunistic Sell** (`opportunisticSell.js`): Proactive sell order placement on price spikes and market windows.
- **Refining pipelines**: Buy → refine/convert → sell loops for commodity/profit cycles, supporting multi-input COMMODITIES recipes.
- **Deposit and mineral management**:
  - Remote deposit harvesting
  - Mineral extraction and hauling
  - Automatic bar selling from storage (excluding factory-reserved stock)
  - Periodic highway deposit selling (mist, biomass, metal, silicon)
  - Stockpile processing through factory/lab workflows

### Strategic & Safety Operations

- **Friend-or-Foe detection** (IFF) and threat scanning to classify rooms and actors.
- **Attack/defense tooling**:
  - Squad orchestration
  - Tower draining missions (4-position bounce with observer-verified lane assignment and cross-sector routing)
  - Tower filling missions (dedicated energy supply for tower defense)
  - Demolition missions (with wall-only focus mode)
  - Contested demolisher pairs for hostile room operations
  - SK attacker teams for Source Keeper combat
  - Controller attacker squads for downgrade operations
  - Nuker loading and launching support
  - Remote claim/defense workflows (with hardcoded route support)
- **Player intelligence gathering**: Scan → analyze → report pipeline with historical tracking.
- **Mission-style automation**: Callable from the console for manual and auto-triggered operations.

### Storage & Distribution Systems (New)

- **Storage Manager** (`storageManager.js`): Centralized storage optimization, reservation tracking, and multi-room balance coordination.
- **Room Balance** (`roomBalance.js`): Intra-room resource distribution with priority management and threshold-based triggering.
- **Local Refine** (`localRefine.js`): On-site refinement operations (factory/lab) without market dependency.
- **Remote Supply Manager** (`remoteSupplyManager.js`): Distributed supply chains for remote rooms, multi-source orchestration, and demand-based spawning.
- **Local Map** (`localMap.js`): Cached local navigation, structure tracking, and path optimization.

### Boost & Special Systems (New)

- **Boost Manager** (`boostManager.js`): Automated boost production, creep boost scheduling, and boost reservation management.
- **Claimbot Range Check** (`claimbotRangeCheck.js`): Pre-mission verification of claim routes and range validation.
- **Task Scheduler** (`taskScheduler.js`): Deferred task execution, priority queuing, and task batching.

## New Highlights (since 2026-01-09)

- **Expanded creep role ecosystem**: Tower Fillers, Combo Bots, Rampart Bots, SK Attackers, Controller Attackers, Remote Suppliers, Static Distributors, Extractor Assistants, and HD (Heavy Defense) roles for specialized operations.
- **Profiling & monitoring suite**: Creep Profiler (per-role efficiency), Energy Profiler (flow analysis), Room CPU Profiler (cost tracking), and comprehensive diagnostics.
- **War & defense systems**: Defense Monitor (real-time threat tracking), War Estimate (battle prediction), Player Monitor (surveillance), and Nuke Analysis (incoming threat detection).
- **Advanced market systems**: Opportunistic Sell, Market Lab unified analysis, and expanded arbitrage coverage.
- **Storage & distribution**: Storage Manager, Remote Supply Manager, Local Refine, and Room Balance for sophisticated logistics.
- **Full market automation suite**: autoTrader (periodic profit-seeking), marketArbitrage (buy-sell spread exploitation), marketLabForward/Reverse (lab pipeline management), marketPricing (centralized WMP), dailyFinance (transaction tracking), and autoEnergyBuyer.
- **Intelligence and reconnaissance**: roomIntel (weighted room scoring), wideScan (observer-range sweeps), playerAnalysis (comprehensive player reports), roomNavigation (shared A* pathfinder).
- **Power Creep support**: roleOperator with modular power priorities, auto-spawning, and full console management lifecycle.
- **Contested demolisher role**: Paired demolisher system with cross-sector BFS routing and observer-verified route scanning.
- **Tower drain overhaul**: Rewritten with 4-position bounce mechanic, observer-based lane scanning, cross-sector highway routing, and per-tick caching.
- **Lab system expansion**: labManager rewritten as multi-group edition with order queuing; roleLabBot expanded for forward and reverse reaction support.
- **Builder simplification**: Removed job queue overhead in favor of direct closest-job selection with rampart reinforcement targets.
- **Tower manager streamlining**: Replaced intent-budget system with lean cached-target approach.
- **Supplier optimization**: Lookup tables, labeled breaks, assignment caching, and distance pre-computation.
- **Market analysis v2.3**: Price source tracking, actionable indicators, order depth warnings, bid-ask spread detection, volume columns, and factory decompression analysis.
- **Expanded console commands**: intel, wideScan, player analysis, claim orders, thief orders, financial reports, pricing, arbitrage status, and more.

## Module Structure

### Core Management
- `main.js` — Main loop orchestration
- `getRoomState.js` — Centralized room state caching
- `spawnManager.js` — Creep and Power Creep spawn management (168K, comprehensive body optimization)
- `taskScheduler.js` — Deferred task execution and priority queuing

### Managers
- `towerManager.js` — Tower defense/heal/repair
- `terminalManager.js` — Terminal balancing and transfers (104K, sophisticated trading logic)
- `factoryManager.js` — Factory production orders
- `labManager.js` — Lab reaction workflows (multi-group)
- `linkManager.js` — Link energy routing
- `roomObserver.js` — Observer scheduling
- `powerManager.js` — Power spawn management
- `maintenanceScanner.js` — Structure maintenance scanning

### Storage & Distribution
- `storageManager.js` — Centralized storage optimization and reservation (24K)
- `roomBalance.js` — Intra-room resource distribution
- `remoteSupplyManager.js` — Distributed remote supply chains (32K)
- `localRefine.js` — On-site factory/lab operations
- `localMap.js` — Cached local navigation and structure tracking (20K)

### Intelligence & Reconnaissance
- `roomIntel.js` — Room scoring and analysis (100K)
- `wideScan.js` — Observer-range room scanning
- `playerAnalysis.js` — Comprehensive player intelligence (68K)
- `roomNavigation.js` — Shared A* room pathfinder
- `playerMonitor.js` — Ongoing player surveillance (40K, new)
- `warEstimate.js` — Strategic battle prediction and strength analysis (100K, new)
- `defenseMonitor.js` — Real-time threat assessment and tower tracking (32K, new)
- `nuke​Analyze.js` — Nuke prediction and defense counter-strategy (72K, new)

### Profiling & Diagnostics
- `creepProfiler.js` — Per-creep role statistics and efficiency (20K, new)
- `energyProfiler.js` — Room-level energy flow and production analysis (52K, new)
- `roomCPUProfiler.js` — Per-room CPU cost and bottleneck tracking (64K, new)
- `statusReport.js` — Comprehensive system status reporting (20K, new)
- `memoryProfiler.js` — Memory usage analysis
- `memoryQuery.js` — Deep Memory search utility
- `screeps-profiler.js` — CPU profiling

### Market & Economy
- `autoTrader.js` — Automated profitable trading (76K)
- `marketArbitrage.js` — Buy-sell spread arbitrage (104K)
- `marketLab.js` — Unified lab reaction pipeline analysis (36K, new)
- `marketLabForward.js` — Buy reagents → combine → sell compound
- `marketLabReverse.js` — Buy compound → break down → sell reagents
- `marketPricing.js` — Weighted Mid-Price calculations
- `marketAnalysis.js` — Profitability tables and order analysis (52K)
- `marketBuy.js` — Buy order workflows
- `marketSell.js` — Sell order workflows
- `marketRefine.js` — Factory refining pipelines (32K)
- `marketQuery.js` — Market order queries
- `marketReport.js` — Market reporting (24K)
- `marketRoomOrders.js` — Per-room order management
- `marketUpdate.js` — Order price updates
- `marketMap.js` — Market price mapping and analysis (4K, new)
- `opportunisticBuy.js` — Opportunistic purchase requests (32K)
- `opportunisticSell.js` — Opportunistic sell order placement (40K, new)
- `autoEnergyBuyer.js` — Automatic energy purchasing
- `dailyFinance.js` — Daily transaction tracking (36K)
- `globalOrders.js` — Global order management
- `mineralManager.js` — Mineral and bar management (24K)

### Specialized Systems
- `boostManager.js` — Automated boost production and scheduling (44K, new)
- `claimbotRangeCheck.js` — Route validation for claim operations (20K, new)
- `roadTracker.js` — Road usage tracking and analysis
- `singleSourceRoom.js` — Single-source room optimization (20K, new)
- `iff.js` — Friend-or-Foe identification

### Creep Roles

**Harvesting & Energy**
- `roleHarvester.js` — Energy harvesting (48K)
- `roleRemoteHarvesters.js` — Remote harvesting
- `roleDepositHarvester.js` — Highway deposit harvesting (24K)
- `roleSupplier.js` — Logistics and hauling (68K)
- `roleRemoteSupplier.js` — Remote room supply (32K, new)
- `roleStaticDistributor.js` — Fixed-position distribution (8K, new)

**Construction & Maintenance**
- `roleBuilder.js` — Construction and repair (28K)
- `roleRemoteBuilder.js` — Remote construction
- `roleRampartBot.js` — Dedicated rampart building and reinforcement (20K, new)
- `roleWallRepair.js` — Wall/rampart repair (24K)
- `roleRepairBot.js` — Structure repair (12K)
- `roleMaintainer.js` — Room maintenance
- `roadBuilder.js` — Automated road construction (8K, new)

**Upgrading & Control**
- `roleUpgrader.js` — Controller upgrading (20K)

**Resource Processing**
- `roleExtractor.js` — Mineral extraction
- `roleExtractorAssistant.js` — Extractor support creeps (16K, new)
- `roleMineralCollector.js` — Mineral collection
- `roleFactoryBot.js` — Factory operations (16K)
- `roleLabBot.js` — Lab operations (forward and reverse) (60K)
- `rolePowerBot.js` — Power processing (16K)

**Power Creeps & Advanced**
- `roleOperator.js` — Power Creep controller (48K)
- `roleComboBot.js` — Flexible multi-purpose creeps (32K, new)
- `roleHD.js` — Heavy Defense specialists (8K, new)

**Scouting & Information**
- `roleScout.js` — Room scouting (48K)
- `roleSignbot.js` — Controller signing (4K)
- `roleScavenger.js` — Resource scavenging (4K)

**Combat & Specialized**
- `roleDefender.js` — Room defense
- `roleAttacker.js` — Attack missions (20K)
- `roleDemolition.js` — Demolition missions (36K)
- `roleContestedDemolisher.js` — Contested room demolition pairs (120K)
- `roleTowerDrain.js` — Tower draining operations (152K)
- `roleTowerFiller.js` — Tower energy supply (12K, new)
- `roleSKAttacker.js` — Source Keeper combat (20K, new)
- `roleControllerAttacker.js` — Controller downgrade operations (20K, new)
- `roleNukeFill.js` — Nuker loading (12K)
- `roleClaimbot.js` — Room claiming (24K)

**Squad & Specialized**
- `roleSquad.js` — Squad coordination (28K)

### Strategic Operations
- `nukeLaunch.js` — Nuke targeting and launch (12K)
- `nukeUtils.js` — Nuke utilities (4K)
- `depositObserver.js` — Deposit monitoring (32K)

### Documentation
- `HowEverythingWorks.txt` — Comprehensive system overview
- `IntelWeights.txt` — Intelligence scoring weights and tuning (16K, new)
- `Notes.txt` — Development notes and architecture decisions

## Console Command Reference

### Intelligence & Monitoring
    intel('W1N1')                          // Score and analyze a room
    listIntel()                            // List all cached intel
    wideScan('PlayerName')                 // Scan all observer-range rooms for a player
    wideScanStatus()                       // Check scan progress
    player('PlayerName')                   // Full player analysis pipeline
    playerStatus()                         // Check analysis progress
    playerLast()                           // Reprint last analysis report
    warEstimate('PlayerName')              // Battle prediction and strength analysis (new)
    defenseStatus()                        // Current threat level and defense readiness (new)
    playerMonitor('PlayerName')            // Start/stop ongoing surveillance (new)

### Market & Economy
    prices()                               // Print all resource prices (WMP)
    prices('energy')                       // Price for specific resource
    financeReport()                        // Daily transaction summary
    autoTrader()                           // Show auto-trader status
    autoTrader('run')                      // Force immediate trading cycle
    selling()                              // Show all active sell orders
    buying()                               // Show all active buy orders
    labForward('E3N46', 'ZO')              // Start forward lab operation
    labReverse('E3N46', 'ZO')              // Start reverse lab operation
    console.log(marketAnalysis())          // Profitability tables
    console.log(reverseReactionAnalysis()) // Reverse reaction profits
    console.log(decompressionAnalysis())   // Factory decompression profits
    console.log(orderBook('ZO'))           // Order book for a resource
    arbitrageStatus()                      // Current arbitrage opportunities (new)

### Production & Logistics
    orderFactory('W1N1', 'Composite', 'max')
    orderLabs('W1N1', 'XGH2O', 2000)
    marketRefine('W1N1', RESOURCE_COMPOSITE)
    transferStuff('E1S1', 'E3S3', RESOURCE_ZYNTHIUM, 5000)
    remoteSupplyStatus('E1S1')             // Check remote supply chains (new)

### Power Creeps
    createOperator('C1')                   // Create a new Operator
    upgradeOperator('C1', PWR_GENERATE_OPS) // Upgrade a power
    setupOperator('C1', 'E2N46')           // Assign to room
    setupOperator('C1', 'E2N46', [PWR_GENERATE_OPS, PWR_OPERATE_FACTORY]) // With priorities
    removeOperator('C1')                   // Remove room assignment

### Combat & Missions
    orderAttack('E3N44', 5, 'E3N45')
    orderTowerDrain('E1S1', 'E2S1', 2)
    orderTowerDrain('E1S1', 'E2S1', 2, 'N')  // Specify attack edge
    orderTowerFill('E1S1', 'E2S1', 2)        // Tower energy supply (new)
    orderDemolition('E1S1', 'E2S2', 2)
    orderDemolition('E1S1', 'E2S2', 2, 'wall') // Wall-only focus
    orderContestedDemolisher('E4N49', 'E4N51')
    orderThieves('W1N1', 'W2N1', 3)
    orderSquad('E1S1', 'W1N1', 2)
    orderSKAttack('E1S1', 'E2S1', 2)       // SK combat mission (new)
    orderControllerAttack('E1S1', 'E2S1')  // Controller downgrade (new)
    launchClaimbot('E1S1', 'E3S3')
    launchClaimbot('E1S1', 'E3S3', ['E2S3', 'E3S3']) // With route

### Defense & Nukes
    orderWallRepair('W1N1', 500000)
    nukeFill('W1N1', { maxPrice: 1.5 })
    launchNuke('W1N1', 'W3N3', 'spawn')
    nukeDefense('W1N1')                    // Plan nuke defense (new)

### Status & Diagnostics
    getTowerDrainStatus()
    getContestedDemolisherStatus()
    listClaimOrders()
    listThiefOrders()
    statusReport()                         // Full system status (new)
    creepProfile()                         // Per-role creep efficiency (new)
    energyFlow()                           // Room energy production/consumption (new)
    roomCPU('E1S1')                        // Per-room CPU breakdown (new)
    memoryQuery('searchTerm')              // Search Memory keys and values
    memoryQueryKeys('searchTerm')          // Search only keys
    memoryQueryValues('searchTerm')        // Search only values

## Installation & Usage

- Clone/copy into your Screeps `src` directory.
- Deploy the main loop (`main.js`) to your Screeps environment.
- Configure per-module constants (thresholds, margins, allowlists/denylists) before upload.
- Review `IntelWeights.txt` for room scoring tuning and threat classification.
- Use console commands to:
  - Gather intelligence on rooms and players with war/defense analysis
  - Schedule factory/lab/market actions
  - Configure automated trading parameters
  - Manage Power Creep assignments
  - Trigger missions (attack/demolition/tower drain/SK combat/controller downgrade)
  - Run scans, profiling, and diagnostics
  - Manage cross-room transfers and remote supply chains
  - View financial reports and market pricing
  - Monitor energy flow, CPU usage, and creep efficiency

## Configuration & Tuning

- **Intel Weights** (`IntelWeights.txt`): Adjust room scoring weights (economic/military/dual-purpose ratios)
- **Boost Management** (`boostManager.js`): Configure boost production priorities and schedules
- **Storage Thresholds** (`storageManager.js`): Set per-resource storage targets and reserve amounts
- **Remote Supply** (`remoteSupplyManager.js`): Define remote room supply priorities and demand levels
- **Tower Strategy** (`towerManager.js`): Tune tower target selection (defend/heal/repair balance)
- **Market Margins** (`marketArbitrage.js`, `autoTrader.js`): Set minimum profit thresholds
- **CPU Throttling** (`roomCPUProfiler.js`): Configure CPU budget allocation per room

## Architecture Highlights

The codebase is structured for:
- **Modularity**: Each subsystem (profiling, storage, market, combat) is independent and reusable
- **Performance**: Heavy use of caching, per-tick budgets, and lazy evaluation
- **Observability**: Real-time profiling, status reporting, and performance tracking
- **Flexibility**: Console API for runtime configuration without redeployment
- **Scalability**: Distributed systems for remote supply, multi-room operations, and concurrent tasks

## Contributing

- Keep new functionality modular (one concern per file/module).
- Document configuration knobs and any console commands added.
- Include CPU impact notes for large loops and high-frequency logic.
- Prefer clear, explicit logging that can be toggled or throttled.
- Add profiling hooks for new hot-path code.
- Use shared infrastructure (roomNavigation, marketPricing, getRoomState, storageManager) where possible rather than duplicating logic.
- Test new creep roles with the creepProfiler before deployment.
- Verify war estimate logic before engaging in major conflicts.