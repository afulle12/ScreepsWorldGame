# Screeps Colony – README
Version: 2026-02-18

## Overview

This repository runs a multi-room Screeps AI that automates economy, logistics, combat, market play, and late-game strategy. The codebase is modular: each subsystem lives in its own module and is orchestrated from the main loop. The latest release massively expands automated market trading (arbitrage, forward/reverse lab pipelines, auto-trading), adds a full intelligence and reconnaissance suite, introduces Power Creep support, and brings new combat roles for contested room operations.

## Core Systems

### Creep & Squad Roles

- Harvesters
- Upgraders
- Builders
- Suppliers / Haulers
- Scouts
- Defenders
- Attackers
- Thieves (with order system and observer-scanned routing)
- Tower Drainers (full 4-position bounce mechanic with route scanning)
- Demolition teams
- Contested Demolishers (paired demolisher system for hostile rooms)
- Claimbots (with hardcoded route support)
- Mineral Collectors
- Extractors
- Factory Bots
- Lab Bots (forward and reverse reaction support)
- Power Bots (with low-TTL resource recovery)
- Operators (Power Creep controller with modular power priorities)
- Remote Builders
- Deposit Harvesters
- Signers
- Wall Repair
- Terminal Bots
- Squad members and multi-creep mission roles

Each role owns its behavior module, with spawn bodies tuned for distance, TTL, or mission needs. Specialized teams (tower drainers, demolition, contested demolishers, thieves) use observer-scanned routing and staged/rally logic for multi-room operations.

### Infrastructure & Room Intelligence

- Room state caching: centralized, cached views of structures, creeps, and key room metadata.
- Room intelligence scoring: weighted analysis of rooms across Economic (25%), Military (30%), and Dual Purpose (45%) categories with auto-expiring caches.
- Observer scanning: scheduled room visibility sweeps with fallback chain (structural observer → Operator with PWR_OPERATE_OBSERVER → manual scouting).
- Wide scan: full observer-range sweep to find all rooms owned by a target player.
- Player analysis: multi-phase intelligence pipeline (wideScan → roomIntel → comprehensive report with strength classifications, aggregated scores, and nuke capability comparison).
- Room navigation: shared A* room-level pathfinder respecting observer-scanned blocked rooms and custom ban lists.
- Managers:
  - Link routing and energy distribution
  - Terminal balancing and transfers
  - Towers (streamlined cached-target defense/heal/repair)
  - Factory production order handling (with COMMODITIES fallback for advanced recipes)
  - Lab reaction workflows (multi-group edition with order queuing)
  - Power spawn support
  - Power Creep (Operator) lifecycle management

### Resource & Market Automation

- Automated trading: periodic analysis and execution of profitable reverse reactions and factory compression jobs with configurable margin thresholds.
- Market arbitrage: buy-sell spread exploitation with per-terminal state machines and full energy cost accounting on both transaction legs.
- Lab pipelines: dedicated forward (buy reagents → combine → sell compound) and reverse (buy compound → break down → sell reagents) operation managers supporting concurrent operations per room.
- Centralized pricing: Weighted Mid-Price calculation across all resources for consistent valuation.
- Daily finance tracking: transaction monitoring with midnight resets, hourly snapshots, and report generation.
- Market analysis: comprehensive profitability tables for factory production, factory decompression, lab production, and reverse reactions with price source tracking (LIVE/HIST/MBUY), actionable indicators, and order depth warnings.
- Auto energy buying: automatic energy purchases when room storage falls below configurable thresholds.
- Buyer/Seller workflows for routine trading and opportunistic market actions.
- Refining pipelines (buy → refine/convert → sell) for commodity/profit loops, now supporting multi-input COMMODITIES recipes.
- Deposit and mineral management:
  - Remote deposit harvesting
  - Mineral extraction and hauling
  - Automatic bar selling from storage (excluding factory-reserved stock)
  - Periodic highway deposit selling (mist, biomass, metal, silicon)
  - Stockpile processing through factory/lab workflows

### Strategic & Safety Operations

- Friend-or-Foe detection (IFF) and threat scanning to classify rooms and actors.
- Attack/defense tooling:
  - Squad orchestration
  - Tower draining missions (4-position bounce with observer-verified lane assignment and cross-sector routing)
  - Demolition missions (with wall-only focus mode)
  - Contested demolisher pairs for hostile room operations
  - Nuker loading and launching support
  - Remote claim/defense workflows (with hardcoded route support)
- Player intelligence gathering (scan → analyze → report pipeline)
- Mission-style automation designed to be callable from the console.

### CPU & Diagnostics

- CPU optimization patterns:
  - Cached state reads and per-tick caches
  - Throttled/staged execution
  - Reduced per-tick recalculation where possible
  - Lookup tables and assignment caching in hot-path roles
  - Memory path cleanup on idle creeps
- Memory query utility for deep recursive search through Memory.
- Console API for live control, debugging, and scheduling without redeploying code.
- Wall/rampart progress tracking with ETA calculations.
- Daily financial reporting.

## New Highlights (since 2026-01-09)

- **Full market automation suite**: autoTrader (periodic profit-seeking), marketArbitrage (buy-sell spread exploitation), marketLabForward/Reverse (lab pipeline management), marketPricing (centralized WMP), dailyFinance (transaction tracking), and autoEnergyBuyer.
- **Intelligence and reconnaissance**: roomIntel (weighted room scoring), wideScan (observer-range sweeps), playerAnalysis (comprehensive player reports), roomNavigation (shared A* pathfinder).
- **Power Creep support**: roleOperator with modular power priorities, auto-spawning, and full console management lifecycle.
- **Contested demolisher role**: paired demolisher system with cross-sector BFS routing and observer-verified route scanning.
- **Tower drain overhaul**: rewritten with 4-position bounce mechanic, observer-based lane scanning, cross-sector highway routing, and per-tick caching.
- **Lab system expansion**: labManager rewritten as multi-group edition with order queuing; roleLabBot expanded for forward and reverse reaction support.
- **Builder simplification**: removed job queue overhead in favor of direct closest-job selection with rampart reinforcement targets.
- **Tower manager streamlining**: replaced intent-budget system with lean cached-target approach.
- **Supplier optimization**: lookup tables, labeled breaks, assignment caching, and distance pre-computation.
- **Market analysis v2.3**: price source tracking, actionable indicators, order depth warnings, bid-ask spread detection, volume columns, and factory decompression analysis.
- **Expanded console commands**: intel, wideScan, player analysis, claim orders, thief orders, financial reports, pricing, arbitrage status, and more.

## Module Structure

### Managers
- `main.js` — Main loop orchestration
- `getRoomState.js` — Centralized room state caching
- `spawnManager.js` — Creep and Power Creep spawn management
- `towerManager.js` — Tower defense/heal/repair
- `terminalManager.js` — Terminal balancing and transfers
- `factoryManager.js` — Factory production orders
- `labManager.js` — Lab reaction workflows (multi-group)
- `linkManager.js` — Link energy routing
- `roomObserver.js` — Observer scheduling
- `powerManager.js` — Power spawn management
- `maintenanceScanner.js` — Structure maintenance scanning

### Intelligence & Reconnaissance
- `roomIntel.js` — Room scoring and analysis
- `wideScan.js` — Observer-range room scanning
- `playerAnalysis.js` — Comprehensive player intelligence
- `roomNavigation.js` — Shared A* room pathfinder

### Market & Economy
- `autoTrader.js` — Automated profitable trading
- `marketArbitrage.js` — Buy-sell spread arbitrage
- `marketLabForward.js` — Buy reagents → combine → sell compound
- `marketLabReverse.js` — Buy compound → break down → sell reagents
- `marketPricing.js` — Weighted Mid-Price calculations
- `marketAnalysis.js` — Profitability tables and order analysis
- `marketBuy.js` — Buy order workflows
- `marketSell.js` — Sell order workflows
- `marketRefine.js` — Factory refining pipelines
- `marketQuery.js` — Market order queries
- `marketReport.js` — Market reporting
- `marketRoomOrders.js` — Per-room order management
- `marketUpdate.js` — Order price updates
- `opportunisticBuy.js` — Opportunistic purchase requests
- `autoEnergyBuyer.js` — Automatic energy purchasing
- `dailyFinance.js` — Daily transaction tracking
- `globalOrders.js` — Global order management
- `roomBalance.js` — Room resource balancing
- `localRefine.js` — Local refining operations
- `mineralManager.js` — Mineral and bar management

### Creep Roles
- `roleHarvester.js` — Energy harvesting
- `roleUpgrader.js` — Controller upgrading
- `roleBuilder.js` — Construction and repair
- `roleSupplier.js` — Logistics and hauling
- `roleScout.js` — Room scouting
- `roleDefender.js` — Room defense
- `roleAttacker.js` — Attack missions
- `roleThief.js` — Resource theft with order system
- `roleTowerDrain.js` — Tower draining operations
- `roleDemolition.js` — Demolition missions
- `roleContestedDemolisher.js` — Contested room demolition pairs
- `roleClaimbot.js` — Room claiming
- `roleMineralCollector.js` — Mineral collection
- `roleExtractor.js` — Mineral extraction
- `roleFactoryBot.js` — Factory operations
- `roleLabBot.js` — Lab operations (forward and reverse)
- `rolePowerBot.js` — Power processing
- `roleOperator.js` — Power Creep controller
- `roleRemoteBuilder.js` — Remote construction
- `roleRemoteHarvesters.js` — Remote harvesting
- `roleDepositHarvester.js` — Highway deposit harvesting
- `roleSignbot.js` — Controller signing
- `roleWallRepair.js` — Wall/rampart repair
- `roleRepairBot.js` — Structure repair
- `roleMaintainer.js` — Room maintenance
- `roleScavenger.js` — Resource scavenging
- `roleNukeFill.js` — Nuker loading
- `roleSquad.js` — Squad coordination

### Strategic Operations
- `nukeLaunch.js` — Nuke targeting and launch
- `nukeUtils.js` — Nuke utilities
- `depositObserver.js` — Deposit monitoring

### Utilities & Diagnostics
- `iff.js` — Friend-or-Foe identification
- `roadTracker.js` — Road usage tracking
- `memoryProfiler.js` — Memory usage analysis
- `memoryQuery.js` — Deep Memory search utility
- `screeps-profiler.js` — CPU profiling

## Console Command Reference

### Intelligence
    intel('W1N1')                          // Score and analyze a room
    listIntel()                            // List all cached intel
    wideScan('PlayerName')                 // Scan all observer-range rooms for a player
    wideScanStatus()                       // Check scan progress
    player('PlayerName')                   // Full player analysis pipeline
    playerStatus()                         // Check analysis progress
    playerLast()                           // Reprint last analysis report

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

### Production & Logistics
    orderFactory('W1N1', 'Composite', 'max')
    orderLabs('W1N1', 'XGH2O', 2000)
    marketRefine('W1N1', RESOURCE_COMPOSITE)
    transferStuff('E1S1', 'E3S3', RESOURCE_ZYNTHIUM, 5000)

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
    orderDemolition('E1S1', 'E2S2', 2)
    orderDemolition('E1S1', 'E2S2', 2, 'wall') // Wall-only focus
    orderContestedDemolisher('E4N49', 'E4N51')
    orderThieves('W1N1', 'W2N1', 3)
    orderSquad('E1S1', 'W1N1', 2)
    launchClaimbot('E1S1', 'E3S3')
    launchClaimbot('E1S1', 'E3S3', ['E2S3', 'E3S3']) // With route

### Defense & Nukes
    orderWallRepair('W1N1', 500000)
    nukeFill('W1N1', { maxPrice: 1.5 })
    launchNuke('W1N1', 'W3N3', 'spawn')

### Status & Diagnostics
    getTowerDrainStatus()
    getContestedDemolisherStatus()
    listClaimOrders()
    listThiefOrders()
    memoryQuery('searchTerm')              // Search Memory keys and values
    memoryQueryKeys('searchTerm')          // Search only keys
    memoryQueryValues('searchTerm')        // Search only values

## Installation & Usage

- Clone/copy into your Screeps `src` directory.
- Deploy the main loop (`main.js`) to your Screeps environment.
- Configure per-module constants (thresholds, margins, allowlists/denylists) before upload.
- Use console commands to:
  - gather intelligence on rooms and players
  - schedule factory/lab/market actions
  - configure automated trading parameters
  - manage Power Creep assignments
  - trigger missions (attack/demolition/tower drain/contested demolish)
  - run scans and diagnostics
  - manage cross-room transfers
  - view financial reports and market pricing

## Contributing

- Keep new functionality modular (one concern per file/module).
- Document configuration knobs and any console commands added.
- Include CPU impact notes for large loops and high-frequency logic.
- Prefer clear, explicit logging that can be toggled or throttled.
- Use shared infrastructure (roomNavigation, marketPricing, getRoomState) where possible rather than duplicating logic.