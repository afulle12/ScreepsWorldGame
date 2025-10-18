<details><summary>Thinking</summary>

The user is asking me to update a README based on changes they've mentioned. However, I notice they said "Given this readme and these changes" but I don't see the actual changes document attached - they only provided a summary of changes at the beginning.

Looking at what they provided:
1. A summary of major changes (the "Summary" section at the top with all the bullet points about modified files)
2. The current README

What I need to do:
- Incorporate the changes described in that summary into the README
- Update sections that have changed
- Add new sections for new functionality
- Make sure the README reflects all the new systems mentioned

Key updates based on the summary:
1. New modules: getRoomState.js, globalOrders, labManager, linkManager, marketAnalysis, marketBuyer, marketSell, etc.
2. New roles: roleMineralCollector, squad system, towerManager
3. Enhanced existing systems: factoryManager, roleBuilder, roleHarvester, roleSupplier, terminalManager, etc.
4. New management systems: spawnManager, market automation, lab reactions, link management

I should update the README to reflect:
- The new roles and managers
- New console commands for the new systems (lab orders, market analysis, etc.)
- Market automation features
- Lab reaction management
- Link manager
- Room state caching
- Squad system (though this is mentioned)

Let me create an updated README that incorporates these changes.

</details>

# Screeps Colony – README

*Version: 2025‑10‑18*

---

## 📖 Overview

This repository powers a **multi‑room AI colony** for **Screeps World**.  
All core decisions—creep roles, resource logistics, combat, and expansion—are hand‑crafted and continuously refined through live‑game testing.

The system is **modular**: each subsystem lives in its own module and is invoked from the main loop (`module.exports.loop`).  
**Major refactor:** Introduces centralized room‑state caching, automated market trading, lab reaction management, advanced logistics (suppliers, harvesters, factory bots), squad/attack orchestration, and a comprehensive suite of utility modules.

---

## 🧩 Core Systems

### 1️⃣ Creep Roles

| Role | Primary duties | Highlights |
|------|----------------|-----------|
| **🧑‍🌾 Harvester** | Harvests sources, caches source assignments, idles by source when empty. | Balanced source assignments, regeneration‑aware waiting, per‑room cache, robust stuck handling. |
| **⚡ Upgrader** | Refills controller, pulls energy from storage / container / link. | Cached controller, fast source lookup, fallback to harvesting. |
| **🔨 Builder** | Global job queue (repair, build, wall repair) with urgency‑based selection. | Cached room data, priority‑tiered top‑K job selection, smart energy acquisition, reroute controls. |
| **🔭 Scout** | Exploration, path‑finding, danger detection, black‑listing. | Stuck detection, local & mission blacklists, auto‑explorer. |
| **🛡️ Defender** | Ranged combat, IFF whitelisting, target‑switching. | — |
| **⚔️ Attacker** | Console‑orderable attacks, rally system, custom path‑finding with blacklists. | Hostile‑tower avoidance, coordinated retreat/heal logic, cached path clearing. |
| **🔋 Supplier** | Energy logistics with prioritized task system. | Spawn/extension/tower/link/container/material/terminal balancing, anti‑stuck logic, mineral deliveries. |
| **🗺️ Claimbot** | Claims or attacks controllers with edge‑avoidance. | Controller‑path caching, interactive logging. |
| **💎 Miner** | Extracts minerals, drops them immediately. | — |
| **🧪 Extractor** | Harvests minerals from extractor, drops into container. | — |
| **💠 Mineral Collector** | Sweeps non‑energy minerals into storage and retires. | *New role.* |
| **🧪 FactoryBot** | Feeds factories, evacuates finished product, drains leftovers. | Multi‑input recipes, startup drain, post‑order evacuation, smarter standby behavior. |
| **🧟‍♂️ Thief** | Steals resources from enemy structures, returns home. | Filters allied/rampart‑protected structures, respects home deposits, clears stale targets. |
| **⚡ TowerDrain** | Positions on room border, retreats to heal, returns home. | — |
| **💣 Demolition** | Demolition‑team logic (demolisher + collector). | — |
| **🧱 RemoteHarvester** *(disabled)* | Tiered body scaling, long‑distance harvesting. | Tiered body selection, flee logic with timers, smarter deposit targeting. |
| **🧱 Scavenger** | Picks up dropped resources, delivers to storage. | — |
| **🪧 Signbot** | Signs room controllers. | — |
| **🛠️ SquadMember** | Part of a 2×2 quad squad (attack, heal, pack). | Quad formation packing, cost‑matrix transformation for group movement, per‑member healing. |
| **🧑‍🔧 TerminalBot** | Handles terminal operations (buy/sell/transfer). | Market order creation, dynamic pricing, transfer energy checks, per‑operation spawn policies. |
| **🧱 RoadTracker** *(optional, disabled)* | Tracks road usage, visualises over‑/under‑used tiles. | — |

---

### 2️⃣ Defense & Infrastructure

- **Advanced Tower Logic** – Cached hostile/injured/damaged/wall scans, special targeting (healers vs workers), rate‑limited repairs, IFF whitelist prevents friendly fire.
- **Link Network** – Cached donor/storage/recipient classification (refreshed every 50 ticks), cost‑aware link sends, single‑intent enforcement per room.
- **Smart Path‑finding** – Used by scouts, attackers, and squads; includes stuck detection and dynamic blacklisting.
- **Road & Container Management** – Supplier role balances containers (donor / hybrid / recipient) and handles terminal‑energy balancing.

---

### 3️⃣ Advanced Resource Management

- **Factory Manager** – FIFO per‑room factory orders, multi‑resource inputs, factory‑level requirements, "max" production mode, per‑room capacity tracking, richer order state (active/queued).
- **Lab Manager** – Automated lab reaction orchestration: layout discovery, chain planning, throttled validation, evacuation logic, full console tooling (order/cancel/show/debug/stats).
- **Terminal Manager** – Full market + transfer orchestrator: market buy/sell order creation, dynamic pricing, transfer energy checks, per‑operation spawn policies, single terminal bot per room, automatic cleanup.
- **Market Automation** – Energy‑decay analytics, commodity profitability reports, automated market buy/sell flows, price lookups, market upkeep, post‑mining processing/sales, price‑sensitive opportunistic purchasing.
- **Link Manager** – Cached donor/storage/recipient classification refreshed every 50 ticks, cost‑aware link sends, single‑intent enforcement.
- **Room State Caching** – Per‑tick cached snapshots of owned/visible rooms (structures grouped by type, creeps, hostiles, resources) feeding quick lookups across all systems.

---

### 4️⃣ Colony & Resource Management

- **Centralized Spawn Manager** – Orchestrates all spawn logic (harvesters, defenders, suppliers, lab bots, demolition/attack/tower drain crews), emergency cases, role counts, delays, and global targets.
- **Dynamic Creep Scaling** – Body tiers per room energy; emergency spawns when energy low.
- **Emergency Harvesters** – Spawned when no harvesters exist.
- **Low‑Energy Spawn Dampening** – Delays spawns when total energy < 800.
- **CPU & Performance Profiling** – `screeps-profiler` integrated, toggleable.
- **Analytics** – GCL/RCL ETA, per‑room creep stats, CPU usage logs, energy‑income tracking, daily kill counter.

---

## ✨ New Features (since previous Version)

- **Lab Manager** (`labManager.js`) – Automated lab reaction manager with layout discovery, chain planning, throttled validation, evacuation logic, and console tools.
- **Market Automation** (`marketAnalysis.js`, `marketBuyer.js`, `marketSell.js`, `marketQuery.js`, `marketUpdate.js`, `opportunisticBuy.js`) – Energy decay analytics, commodity profitability, automated buy/sell flows, price lookups.
- **Room State Caching** (`getRoomState.js`) – Per‑tick cached snapshots feeding rapid lookups across all systems.
- **Link Manager** (`linkManager.js`) – Replaces inline link handler with cached classification and cost‑aware sends.
- **Tower Manager** (`towerManager.js`) – Cached hostile/injured/damaged/wall scans, special targeting, rate‑limited repairs.
- **Spawn Manager** (`spawnManager.js`) – Centralizes all spawn logic and role orchestration.
- **Mineral Manager** (`mineralManager.js`) – Post‑mining processing and sales.
- **Maintenance Scanner** (`maintenanceScanner.js`) – Infrastructure upkeep tracking.
- **Mineral Collector Role** (`roleMineralCollector.js`) – Dedicated collector for non‑energy minerals.
- **Squad Module Enhancements** (`squadModule.js`) – Quad formation packing, cost‑matrix transformation, per‑member healing.
- **Enhanced Harvester** (`roleHarvester.js`) – Balanced source assignments, regeneration‑aware waiting, robust stuck handling.
- **Enhanced Builder** (`roleBuilder.js`) – Global job queue with urgency‑based selection, cached room data, smart energy acquisition.
- **Enhanced Supplier** (`roleSupplier.js`) – Prioritized task system, mineral deliveries, anti‑stuck logic.
- **Enhanced Factory Bot** (`roleFactoryBot.js`) – Multi‑input recipes, startup drain, post‑order evacuation.
- **Enhanced Remote Harvesters** (`roleRemoteHarvesters.js`) – Tiered body selection, flee logic, smarter deposit targeting.
- **Global Orders Console** (`globalOrders.js`) – Consolidated commands for wall repair, thieves, tower drains, demolition, squads, attacks, signers, lab bots with dependency checks.

---

## 🚀 Console Command Reference

All console commands return a short status string and log details to the console. Use the exact case shown (Screeps is case‑sensitive).

### Factory Manager

```javascript
orderFactory('W1N1', 'Oxidant', 1000);          // FIFO per room
cancelFactoryOrder('W1N1');                      // cancel all orders in W1N1
cancelFactoryOrder('W1N1', 'Oxidant');            // cancel only Oxidant orders
factoryOrders();                                  // list active orders
listFactoryOrders();                              // detailed factory order display
```

### Lab Manager

```javascript
orderLabReaction('W1N1', 'product', targetAmount);   // queue lab reaction
cancelLabReaction('W1N1');                           // cancel lab orders in room
showLabStatus('W1N1');                               // display lab state
debugLabLayout('W1N1');                              // show lab positions
labReactionStats('W1N1');                            // reaction statistics
```

### Terminal Manager & Market

```javascript
// Market buy – optional spawn flag
marketBuy('E1S1', RESOURCE_ENERGY, 10000, 0.5, 'spawn');  // spawn bot
marketBuy('E1S1', RESOURCE_ENERGY, 10000, 0.5);             // no bot

// Sell – optional spawn flag
marketSell('E2S2', RESOURCE_HYDROGEN, 5000, 2.0, 'spawn');  // spawn bot
marketSell('E2S2', RESOURCE_HYDROGEN, 5000, 2.0);               // no bot

// Transfer (always requests a bot if needed)
transferStuff('E1S1', 'E3S3', RESOURCE_ENERGY, 3000);

terminalStatus();                              // show all terminal operations
cancelTerminalOperation('buy_1691900000_abc123'); // cancel by internal ID
checkMarketStatus();                           // debug market order status
```

### Market Analysis & Pricing

```javascript
analyzeCommodityProfit(RESOURCE_ENERGY);        // profitability report
checkMarketPrice(RESOURCE_HYDROGEN);             // current market price
updateMarketData();                              // refresh price cache
```

### Scout

```javascript
orderExplore('W1N8');                // send scout to explore
orderCheckRoom('E2N3', 'E9N44');       // check path
orderAutonomousScout();              // fire‑and‑forget explorer
orderPathfinder('W1N8', 'E5N8');       // safe path (returns mission ID)
```

### Attacker

```javascript
orderAttack('E3N44', 5);               // auto‑rally
orderAttack('E3N44', 5, 'E3N45');        // explicit rally room
cancelAttackOrder('E3N44');               // cancel attack
```

### Squad

```javascript
orderSquad('E1S1', 'W1N1', 2);           // spawn 2 squads (4 creeps each)
cancelSquadOrder('W1N1');                  // cancel all squads targeting W1N1
```

### Tower Drain

```javascript
orderTowerDrain('E1S1', 'E2S1', 2);        // 2 drain bots
cancelTowerDrainOrder('E1S1', 'E2S1');
```

### Demolition

```javascript
orderDemolition('E1S1', 'E2S2', 2);          // 2 demolition teams
cancelDemolitionOrder('E2S2');
```

### Thief

```javascript
orderThieves('W1N1', 'W2N1', 3);           // 3 thieves
cancelThiefOrder('W2N1');
```

### Miner & Mineral Collector

```javascript
orderMineralCollect('W8N3');               // spawn mineral collector
```

### Signbot

```javascript
orderSign('W1N1', 'W2N2', 'Hello from my colony!');
```

---

## 📦 Installation & Usage

1. **Clone** the repository into your Screeps `src` folder.
2. **Run** the main loop (`module.exports.loop`) from `main.js`.
3. **Enable** the profiler (optional):

   ```javascript
   const profiler = require('screeps-profiler');
   profiler.enable();   // place before the main loop
   ```

4. **Configure** per‑room settings (e.g., `SUPPLIER_ENABLED`, `MAX_REMOTE_HARVESTERS`) by editing the corresponding module files.

---

## 📂 Module Structure

**Managers:**
- `getRoomState.js` – Central room state cache
- `factoryManager.js` – Factory order orchestration
- `labManager.js` – Lab reaction automation
- `linkManager.js` – Link network coordination
- `towerManager.js` – Tower priority and targeting
- `terminalManager.js` – Terminal + market operations
- `spawnManager.js` – Centralized spawn orchestration

**Market & Resources:**
- `marketAnalysis.js` – Commodity profitability
- `marketBuyer.js` – Automated buy orders
- `marketSell.js` – Automated sell orders
- `marketQuery.js` – Price lookups
- `marketUpdate.js` – Market data upkeep
- `opportunisticBuy.js` – Price‑sensitive purchasing
- `mineralManager.js` – Post‑mining processing

**Utility:**
- `maintenanceScanner.js` – Infrastructure upkeep tracking
- `globalOrders.js` – Consolidated console commands
- `roadTracker.js` – Road usage visualization
- `iff.js` – Whitelist and helper functions

**Roles:** (each in `role*.js`)
- `roleHarvester`, `roleBuilder`, `roleSupplier`, `roleAttacker`, `roleDefender`, `roleClaimbot`, `roleFactory​Bot`, `roleThief`, `roleTowerDrain`, `roleRemoteHarvesters`, `roleMineralCollector`, `squadModule`, and others.

---

## 🤝 Contributing

- Follow the repository's coding style (no optional chaining, plain `if/else`, `const`/`let`).
- Add new features as separate modules and register them in `main.js`.
- Write unit‑style tests in the `test/` folder (if using `screeps-test`).
- Submit PRs with clear descriptions and any performance impact.

---

*Happy colonising!* 🚀