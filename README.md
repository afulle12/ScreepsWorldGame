# Screeps Colony – README

*Version: 2025‑10‑24*

---

## 📖 Overview

This repository powers a **multi‑room AI colony** for **Screeps World**.  
All core decisions—creep roles, logistics, combat, RCL progression, market operations, and nuclear warfare—are hand‑crafted and continuously refined through live‑game testing.

The system is **modular**: every subsystem lives in its own module and is invoked from the main loop (`module.exports.loop`).  
**Latest refactor:** Tightens room‑state caching, expands factory automation to high‑tier commodities, introduces full terminal workforce orchestration, adds refinery and nuke pipelines, and greatly broadens spawn management coverage.

---

## 🧩 Core Systems

### 1️⃣ Creep Roles

| Role | Primary duties | Highlights |
|------|----------------|-----------|
| **🧑‍🌾 Harvester** | Harvests assigned source, idles at source when buffers full. | Distance‑scaled bodies, regeneration guard, spawn‑room cache, emergency fallbacks. |
| **⚡ Upgrader** | Controller upgrades with storage/fallback harvesting. | Controller‑range source cache, structural withdraw preference, TTL‑aware throttling. |
| **🔨 Builder** | Builds/repairs from global job queue. | Central room cache, urgency‑based top‑K selection, edge avoidance. |
| **🔭 Scout** | Exploration, safe pathing, danger blacklists. | Dynamic blacklist per mission, quad avoidance, observer integration. |
| **🛡️ Defender** | Ranged defense. | Quad heater targeting, packed logistics. |
| **⚔️ Attacker** | Console‑driven attacks with rally/target assignment. | Tower avoidance, healer priority, per‑target tracking, multi‑room staging. |
| **🔋 Supplier** | Energy & resource logistics. | Intent‑first planner, container labelling (donor/hybrid/recipient/materials), terminal integration. |
| **🗺️ Claimbot** | Claims/attacks controller with edge avoidance. | Controller path caching, renewable support. |
| **💎 Miner** | Extracts minerals, drops instantly. | TTL reset, container binding. |
| **🧪 Extractor** | Mineral harvesting via extractor+container pairs. | Auto spawn/renew pipeline, fallback caching. |
| **💠 Mineral Collector** | Sweeps non‑energy minerals to storage. | Room‑wide stock scan, TTL auto‑retire. |
| **🧪 FactoryBot** | Feeds/drenches factories. | Multi‑input recipes, startup drain, high‑tier commodities (Composite/Crystal/Liquid), factory level enforcement. |
| **🧟‍♂️ Thief** | Steals from enemy industry. | Rampart detection, extension/storage targeting, resource‑aware deposit. |
| **⚡ TowerDrain** | Border drain squads. | Heal retreat phase, paired positions, TTL auto‑return. |
| **💣 Demolition** | Demolisher/collector tandems. | Team IDs, partner respawn, whitelist guard. |
| **🧱 RemoteHarvester** *(disabled)* | Long‑distance harvesting. | Tiered body planner, flee timer, deposit retarget. |
| **🧱 Scavenger** | Scoop dropped resources + notify. | Spawn on tower kills, controller idle. |
| **🪧 Signbot** | Signs controllers with custom message. | Path fallback + TTL retire. |
| **🛠️ SquadMember** | 2×2 quad squads. | Cost‑matrix transform, formation packing, heal routing. |
| **🧑‍🔧 TerminalBot** | Local terminal logistics. | Collect/drain/storage shuttling, market integration. |
| **🧱 WallRepair** | Thresholded wall & rampart repair. | Edge‑avoiding pathfinder, order queue with TTL renew. |
| **🧑‍🔧 NukeFill** | Nuker refueller. | Energy + ghodium stages, opportunistic buy integration. |

---

### 2️⃣ Defense, Infrastructure & Nuclear

- **Advanced Tower Manager** – Hostile priority cache, per‑room heal budgets, wall/rampart hysteresis, road exclusion, and repair cooldowns.
- **Link Network** – Cached donor/storage/recipient roles, single intent per room, cost‑aware sends.
- **Room State Cache** – Per tick, observer/creep visibility, structured cache with 25‑tick structure TTL.
- **Observer Scanner** – `roomObserver` module with console BFS scan helpers.
- **Nuke Command Stack** – `nukeUtils`, `nukeLaunch`, and `nukeFill` provide range checks, vision scheduling, automated nuker loading, and launch console commands.

---

### 3️⃣ Advanced Economic Automation

- **Factory Manager** – FIFO per room orders, multi‑input recipes, new high‑tier commodities (Composite, Crystal, Liquid) with factory level enforcement, max batch calculator, automatic factory‑bot spawn.
- **Lab Manager** – Reaction chain planner, layout caching, evacuation logic, per‑step queue, console helpers, auto lab bot requests.
- **Terminal Manager** – Unified transfers, local storage↔terminal hauling (`storageToTerminal`, `terminalToStorage`), wait detection, single bot per room, marketSell integration.
- **Market Automation** – Live profitability (`marketAnalysis`), buy/sell orchestration (`marketBuyer`, `marketSell`), local refine pipeline (`marketRefine`), opportunistic buy requests.
- **Maintenance Scanner** – Room decay audit by structure class (roads, ramparts, containers, tunnels).

---

### 4️⃣ Colony Management

- **Centralized Spawn Manager** – Coordinates core creeps plus demolition, tower drain, thief, market refine, lab, nuke fill, and squad requests. Per‑room spawn delay for low energy thresholds.
- **Dynamic Harvester Bodies** – Source distance & harvest slot aware body builder with emergency fallback.
- **Attack Pipeline** – Multi‑room attacker staging with rally timers, partial spawn handling, resource‑aware body selection.
- **Terminal Workforce** – Single bot per room, auto‑assignment or request, market sell/resource deficits detection.
- **CPU & Analytics** – Profiler integration, per‑room energy totals, GCL ETA, RCL projection, kill logs.
- **Room Balance** – Cross‑room energy balancing via terminal transfers (100k bursts).

---

## ✨ New Highlights (since previous version)

- **High‑Tier Factory Recipes** – Factory manager now handles Composite/Crystal/Liquid with level gating and max batch calculus.
- **Expanded Terminal Ops** – Full local shuttle support, operation wait introspection (`whyTerminal`), single bot cap per room, market sell intents.
- **Market Refinery Pipeline** – `marketRefine` orchestrates buy → refine → sell loops, leverages `opportunisticBuy`, factory orders, and terminal automation.
- **Nuke Suite** – Automated nuker filling (`nukeFill`), range checks (`nukeUtils.nukeInRange`), staged launches with observer vision (`nukeLaunch`).
- **Observer Scanner CLI** – `scanRoomsStart`, `scanRoomsStep`, `scanRoomsStatus`, `scanRoomsPrint`, `scanRoomsNow`.
- **Spawn Coverage** – Spawn manager now handles demolition teams, tower drain, thieves, extractors, lab bots, nuke fill, and emergency harvester logic.
- **Tower AI Overhaul** – Intent budgets, road exclusion, healer prioritization, wall/rampart hysteresis, central run cache.
- **Harvester Cache** – Per‑room source metadata with spawn distance and open slot count, distance‑scaled body planner.
- **Terminal Bots Auto‑Switch** – Determine next needed resource (transfer + market sell), dynamic retasking, network aware cleanup.
- **Wall Repair Orders** – `orderWallRepair`/`wallRepairStatus`/`cancelWallRepair` queue targeted wall ramps to custom thresholds.

---

## 🚀 Console Command Reference

### Factory Manager

```javascript
orderFactory('W1N1', 'Oxidant', 1000);
orderFactory('W1N1', 'Composite', 'max');  // uses current room stock
cancelFactoryOrder('W1N1', 'Composite');
listFactoryOrders('W1N1');
```

### Lab Manager

```javascript
orderLabs('W1N1', 'XGH2O', 2000);
cancelLabs('W1N1');
showLabs('W1N1');
labsDebugOn(); labsDebugOff();
labsStats();
```

### Terminal Manager & Market

```javascript
// Market transfer
transferStuff('E1S1', 'E3S3', RESOURCE_ZYNTHIUM, 5000);
storageToTerminal('E1S1', RESOURCE_CATALYST, 2000);   // local move
terminalToStorage('E1S1', RESOURCE_ENERGY, 5000);

// Diagnostics & control
terminalStatus();
whyTerminal('E1S1');
cancelTerminalOperation('transfer_1691900000_abc123');

// Market operations
marketBuy('E1S1', RESOURCE_ENERGY, 10000, 0.6);
marketSell('E2S2', RESOURCE_HYDROGEN, 5000);
marketRefine('W1N1', 'Zynthium bar');   // buy→refine→sell pipeline
marketRefineStatus();
marketPrice('RESOURCE_HYDROXIDE', 'sell');
marketAnalysis('sell', 'avg');
```

### Observer Scanner

```javascript
scanRoomsStart('E3N46');   // begin BFS observer sweep
scanRoomsStep();           // run each tick until complete
scanRoomsStatus();
scanRoomsPrint();          // JSON report
scanRoomsNow('E3N46');     // visible rooms only (no observer)
```

### Combat & Specialists

```javascript
orderAttack('E3N44', 5, 'E3N45');
cancelAttackOrder('E3N44');

orderTowerDrain('E1S1', 'E2S1', 2);
cancelTowerDrainOrder('E1S1', 'E2S1');

orderDemolition('E1S1', 'E2S2', 2);
cancelDemolitionOrder('E2S2');

orderThieves('W1N1', 'W2N1', 3);
cancelThiefOrder('W2N1');

orderWallRepair('W1N1', 500000);
wallRepairStatus('W1N1');
cancelWallRepair('W1N1');

orderSquad('E1S1', 'W1N1', 2);
cancelSquadOrder('W1N1');

nukeFill('W1N1', { maxPrice: 1.5 });   // fill nuker + optional ghodium buy
nukeInRange('W1N1', 'W3N3');
launchNuke('W1N1', 'W3N3', 'spawn');
```

### Support Roles

```javascript
orderMineralCollect('W8N3');
orderSign('W1N1', 'W2N2', 'Hello from my colony!');
orderCheckRoom('E2N3', 'E9N44');
orderAutonomousScout();
orderPathfinder('W1N8', 'E5N8');
```

---

## 📦 Installation & Usage

1. **Clone** into your Screeps `src` directory.
2. **Run** the main loop in `main.js`.
3. **Profiler** (optional):

   ```javascript
   const profiler = require('screeps-profiler');
   profiler.enable();
   ```

4. **Configure** per‑module settings (e.g., `HEAL_BUDGET_PER_ROOM`, `LOW_RCL_SPAWN_DELAY_TICKS`) by editing respective files.

---

## 📂 Module Structure

**Managers:**
- `getRoomState.js` – Central room cache with 25‑tick structure TTL.
- `factoryManager.js` – FIFO orders, max batches, high‑tier recipes.
- `labManager.js` – Reaction chains, evacuation, console tooling.
- `terminalManager.js` – Transfers, local shuttles, bot orchestration, diagnostics.
- `spawnManager.js` – Core creep + specialist spawn coordination (demolition, thieves, tower drain, nuke fill, lab bots, attackers).
- `towerManager.js` – Budgeted towers with hysteresis.
- `roomObserver.js` – Observer scan orchestration.

**Market & Resources:**
- `marketAnalysis.js`, `marketBuy.js`, `marketSell.js`, `marketQuery.js`, `marketUpdate.js`, `opportunisticBuy.js`.
- `marketRefine.js` – Buy→refine→sell pipeline.
- `mineralManager.js` – Stockpile processing + sell triggers.
- `maintenanceScanner.js` – Decay & upkeep metrics.

**Economy Extensions:**
- `marketRefine`, `opportunisticBuy`, `terminalManager`, `marketBuyer`, `marketSell`, `marketUpdate`.

**Nuke Suite:**
- `nukeFill.js`, `nukeUtils.js`, `nukeLaunch.js`.

**Utility:**
- `globalOrders.js` – Aggregated console commands (attack, demolition, thieves, wall repair, etc.).
- `iff.js` – Whitelist & hostile detection.
- `roomBalance.js` – Auto energy rebalancing.
- `roadTracker.js` – Usage heatmap (optional).
- `marketRefine.js`, `opportunisticBuy.js`.

**Roles:** (`role*.js`, `squadModule.js`, etc.)  
Includes harvesters, suppliers, defenders, attackers, lab/factory bots, demolition teams, thieves, tower drain, wall repair, nuke fill, scavengers, signers, scouts, claimbots, squad members, remote harvesters (disabled), extractor/mineral collectors.

---

## 🤝 Contributing

- Follow project style (no optional chaining, explicit `if/else`, `const/let`).
- Add new features as modules, register in `main.js`.
- Write tests under `test/` if using `screeps-test`.
- Submit PRs describing functionality and CPU/impact metrics.

---

*Happy colonizing—and now nuking!* 🚀