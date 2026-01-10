# Screeps Colony – README
Version: 2026-01-09

## Overview

This repository runs a multi-room Screeps AI that automates economy, logistics, combat, market play, and late-game strategy. The codebase is modular: each subsystem lives in its own module and is orchestrated from the main loop. Recent changes expand creep specialization, strategic scouting/defense, CPU-aware throttling, and console-driven control for factories, labs, markets, nukes, and demolition orders.

## Core Systems

### Creep & Squad Roles

- Harvesters
- Upgraders
- Builders
- Suppliers / Haulers
- Scouts
- Defenders
- Attackers
- Thieves
- Tower Drainers
- Demolition teams
- Claimbots
- Mineral Collectors
- Extractors
- Factory Bots
- Lab Bots
- Power Bots
- Remote Builders
- Deposit Harvesters
- Signers
- Wall Repair
- Terminal Bots
- Squad members and multi-creep mission roles

Each role owns its behavior module, with spawn bodies tuned for distance, TTL, or mission needs. Specialized teams (tower drainers, demolition, thieves) use staged/rally logic for multi-room operations.

### Infrastructure & Room Intelligence

- Room state caching: centralized, cached views of structures, creeps, and key room metadata.
- Observer scanning: scheduled room visibility sweeps to support intelligence gathering and targeting.
- Managers:
  - Link routing and energy distribution
  - Terminal balancing and transfers
  - Towers (defense/heal/repair budgets)
  - Factory production order handling
  - Lab reaction workflows
  - Power spawn support (where applicable)

### Resource & Market Automation

- Market analysis and pricing utilities to evaluate buy/sell decisions.
- Buyer/Seller workflows for routine trading and opportunistic market actions.
- Refining pipelines (buy → refine/convert → sell) for commodity/profit loops.
- Deposit and mineral management:
  - Remote deposit harvesting
  - Mineral extraction and hauling
  - Stockpile processing through factory/lab workflows

### Strategic & Safety Operations

- Friend-or-Foe detection (IFF) and threat scanning to classify rooms and actors.
- Attack/defense tooling:
  - Squad orchestration
  - Tower draining missions
  - Demolition missions
  - Nuker loading and launching support
  - Remote claim/defense workflows
- Mission-style automation designed to be callable from the console.

### CPU & Diagnostics

- CPU optimization patterns:
  - Cached state reads
  - Throttled/staged execution
  - Reduced per-tick recalculation where possible
- Console API for live control, debugging, and scheduling without redeploying code.

## New Highlights (since 2025-10-24)

- Expanded role catalog (Power Bots, Remote Builders, Deposit Harvesters, Tower Drainers, etc.) supporting late-game logistics and warfare scenarios.
- Enhanced room analysis and safety suite (automated scans, IFF logic, terrain-aware planning for remote actions).
- Strategic demolition and attack orchestration (console-managed missions with rally stages and automated execution).
- Stronger CPU toolkit (caching, throttling, diagnostics) to keep larger empires responsive under tick pressure.

## Module Structure (selected)

Note: filenames may vary by branch; treat this as a conceptual map of subsystems.

- Managers
  - `getRoomState.js`
  - `spawnManager.js`
  - `towerManager.js`
  - `terminalManager.js`
  - `factoryManager.js`
  - `labManager.js`
  - `roomObserver.js`
  - `powerSpawnManager.js`
- Market & Economy
  - `marketAnalysis.js`
  - `marketBuyer.js`
  - `marketSeller.js`
  - `marketPrice.js`
  - `marketRefine.js`
  - `opportunisticBuy.js`
  - `roomBalance.js`
- Strategic Ops
  - `squadModule.js`
  - `demolitionManager.js`
  - `towerDrainManager.js`
  - `nukeUtils.js`
  - `nukeFill.js`
  - `nukeLaunch.js`
- Utilities & Diagnostics
  - `iff.js`
  - `roadTracker.js`
  - `consoleCommands.js`
  - profiling hooks (optional)

## Console Command Reference (examples)

These are representative examples; see console/command modules for the full list and exact signatures:

    orderFactory('W1N1', 'Composite', 'max');
    orderLabs('W1N1', 'XGH2O', 2000);
    transferStuff('E1S1', 'E3S3', RESOURCE_ZYNTHIUM, 5000);

    marketRefine('W1N1', 'Zynthium bar');
    scanRoomsStart('E3N46');

    orderAttack('E3N44', 5, 'E3N45');
    orderTowerDrain('E1S1', 'E2S1', 2);
    orderDemolition('E1S1', 'E2S2', 2);
    orderThieves('W1N1', 'W2N1', 3);

    orderWallRepair('W1N1', 500000);
    orderSquad('E1S1', 'W1N1', 2);

    nukeFill('W1N1', { maxPrice: 1.5 });
    launchNuke('W1N1', 'W3N3', 'spawn');

## Installation & Usage

- Clone/copy into your Screeps `src` directory.
- Deploy the main loop (`main.js`) to your Screeps environment.
- Configure per-module constants (thresholds, margins, allowlists/denylists) before upload.
- Use console commands to:
  - schedule factory/lab/market actions
  - trigger missions (attack/demolition/tower drain)
  - run scans and diagnostics
  - manage cross-room transfers

## Contributing

- Keep new functionality modular (one concern per file/module).
- Document configuration knobs and any console commands added.
- Include CPU impact notes for large loops and high-frequency logic.
- Prefer clear, explicit logging that can be toggled or throttled.
