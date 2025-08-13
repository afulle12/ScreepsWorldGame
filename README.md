<details><summary>Thinking</summary>

We need to produce updated README without the Disabled/Not-Functional Features section. Also need to keep other sections. Ensure formatting guidelines. Provide updated README. Remove that section entirely. Also keep note about RemoteHarvester being disabled? The user wants to remove that whole section. So we should delete that section entirely. Possibly keep a note elsewhere? The user explicitly says "Remove: Disabled / Not‑Functional Features ... Then give me the updated version". So we should remove that entire section. Possibly we should still mention that RemoteHarvester is disabled? The user wants to remove that section, so we remove it entirely. Provide updated README. Ensure formatting guidelines. Use markdown. Provide concise. Let's produce final README with sections: Overview, Core Systems (Creep Roles table), Defense & Infrastructure, Colony & Resource Management, New Features, Command Reference, Installation & Usage, Contributing. Remove Disabled section. Ensure no leftover. Provide updated README.

</details>

# Screeps Colony – README  

*Version: 2025‑08‑13*  

---

## 📖 Overview  

This repository powers a **multi‑room AI colony** for **Screeps World**.  
All core decisions—creep roles, resource logistics, combat, and expansion—are hand‑crafted and continuously refined through live‑game testing.  

The system is **modular**: each subsystem lives in its own module and is invoked from the main loop (```module.exports.loop```).  
Recent updates add a **Factory Manager**, a **Terminal Manager**, and a fully‑featured **Scout** with intelligent path‑finding and danger‑avoidance.

---

## 🧩 Core Systems  

### 1️⃣ Creep Roles  

| Role | Primary duties | Highlights |
|------|----------------|-----------|
| **🧑‍🌾 Harvester** | Harvests sources, caches source assignments, idles by source when empty. | Source‑balancing, regeneration‑aware waiting, per‑room cache. |
| **⚡ Upgrader** | Refills controller, pulls energy from storage / container / link. | Cached controller, fast source lookup, fallback to harvesting. |
| **🔨 Builder** | Global job queue (repair, build, wall repair). | Cached room data, priority‑tiered job selection, idle‑spot logic. |
| **🔭 Scout** | Exploration, path‑finding, danger detection, black‑listing. | Stuck detection, local & mission blacklists, auto‑explorer. |
| **🛡️ Defender** | Ranged combat, IFF whitelisting, target‑switching. |
| **⚔️ Attacker** | Console‑orderable attacks, rally system, custom path‑finding with blacklists. |
| **🔋 Supplier** | Energy logistics (storage, terminal, containers, links). | Task‑priority system, anti‑stuck logic, dynamic rerouting. |
| **🗺️ Claimbot** | Claims or attacks controllers, edge‑avoidance, path‑finder to target. |
| **💎 Miner** | Extracts minerals, drops them immediately. |
| **🧪 Extractor** | Harvests minerals from extractor, drops into container. |
| **🧪 FactoryBot** | Feeds factories, evacuates finished product, drains leftovers. |
| **🧟‍♂️ Thief** | Steals resources from enemy structures, returns home. |
| **⚡ TowerDrain** | Positions on room border, retreats to heal, returns home. |
| **💣 Demolition** | Demolition‑team logic (demolisher + collector). |
| **🧱 RemoteHarvester** *(disabled)* | Tiered body scaling, long‑distance harvesting. |
| **🧱 Scavenger** | Picks up dropped resources, delivers to storage. |
| **🪧 Signbot** | Signs room controllers. |
| **🛠️ SquadMember** | Part of a 2×2 quad squad (attack, heal, pack). |
| **🧑‍🔧 TerminalBot** | Handles terminal operations (buy/sell/transfer). |
| **🧱 RoadTracker** *(optional, disabled)* | Tracks road usage, visualises over‑/under‑used tiles. |

---

### 2️⃣ Defense & Infrastructure  

- **Advanced Tower Logic** – Prioritises healers, repairs, and wall‑repair; IFF whitelist prevents friendly fire.  
- **Link Network** – Classifies links (donor, storage, recipient) and balances energy.  
- **Smart Path‑finding** – Used by scouts, attackers, and squads; includes stuck detection and dynamic blacklisting.  
- **Road & Container Management** – Supplier role balances containers (donor / hybrid / recipient) and handles terminal‑energy balancing.  

---

### 3️⃣ Colony & Resource Management  

- **Dynamic Creep Scaling** – Body tiers per room energy; emergency spawns when energy low.  
- **Emergency Harvesters** – Spawned when no harvesters exist.  
- **Low‑Energy Spawn Dampening** – Delays spawns when total energy < 800.  
- **CPU & Performance Profiling** – ```screeps-profiler``` integrated, toggleable.  
- **Analytics** – GCL/RCL ETA, per‑room creep stats, CPU usage logs, energy‑income tracking, daily kill counter.  

---

## ✨ New Features (since previous README)

- **Factory Manager** (```factoryManager.js```) – FIFO per‑room factory orders, automatic hauler spawning (```factoryBot```), full recipe support, order completion and draining.  
- **Terminal Manager** (```terminalManager.js```) – Hard‑cap of **one** terminal bot per room (alive + spawning + requested), bots auto‑switch to ENERGY when needed, per‑operation spawn policy (```spawn``` flag), operation‑bot linking, terminal‑busy detection, email/notification support.  
- **Scout Enhancements** – Local blacklist for stuck rooms, path‑finder missions with persistent blacklists, detailed danger detection (hostile creeps, towers, IFF).  
- **Supplier Anti‑Stuck & Reroute** – Stuck detection, side‑step, reroute windows, step‑aside logic, prioritized task selection.  
- **Squad Module** – Quad‑packed formation, cost‑matrix transformation for 2×2 movement, healing logic, packing‑area management.  
- **Terminal Bot Run Wrapper** – ```runTerminalBot``` can be called from the main loop or managed directly by ```terminalManager```.  

---

## 🚀 Console Command Reference  

All console commands return a short status string and log details to the console. Use the exact case shown (Screeps is case‑sensitive).  

### Factory Manager  

```javascript
orderFactory('W1N1', 'Oxidant', 1000);          // FIFO per room
cancelFactoryOrder('W1N1');                      // cancel all orders in W1N1
cancelFactoryOrder('W1N1', 'Oxidant');            // cancel only Oxidant orders
factoryOrders();                               // list active orders
```

### Terminal Manager  

```javascript
// Market buy – optional spawn flag
marketBuy('E1S1', RESOURCE_ENERGY, 10000, 0.5, 'spawn'); // spawn bot
marketBuy('E1S1', RESOURCE_ENERGY, 10000, 0.5);             // no bot

// Sell – optional spawn flag
marketSell('E2S2', RESOURCE_HYDROGEN, 5000, 2.0, 'spawn'); // spawn bot
marketSell('E2S2', RESOURCE_HYDROGEN, 5000, 2.0);               // no bot

// Transfer (always requests a bot if needed)
transferStuff('E1S1', 'E3S3', RESOURCE_ENERGY, 3000);

terminalStatus();                         // show all terminal operations
cancelTerminalOperation('buy_1691900000_abc123'); // cancel by internal ID
checkMarketStatus();                    // debug market order status
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

1. **Clone** the repository into your Screeps ```src``` folder.  
2. **Run** the main loop (```module.exports.loop```) from ```main.js```.  
3. **Enable** the profiler (optional):  

   ```javascript
   const profiler = require('screeps-profiler');
   profiler.enable();   // place before the main loop
   ```  

4. **Configure** per‑room settings (e.g., ```SUPPLIER_ENABLED```, ```MAX_REMOTE_HARVESTERS```) by editing the corresponding module files.  

---

## 🤝 Contributing  

- Follow the repository’s coding style (no optional chaining, plain ```if/else```, ```const```/```let```).  
- Add new features as separate modules and register them in ```main.js```.  
- Write unit‑style tests in the ```test/``` folder (if using ```screeps-test```).  
- Submit PRs with clear descriptions and any performance impact.  

---

*Happy colonising!* 🚀

