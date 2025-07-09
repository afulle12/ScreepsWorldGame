# ScreepsWorldGame

My evolving multi-room AI colony implementation for [Screeps: World](https://store.steampowered.com/app/464350/Screeps_World/), where JavaScript meets strategy gaming.

## 🎮 About

This repository contains the codebase that runs my Screeps colonies 24/7. While I've used AI tools to accelerate development, every strategic decision about **creep behavior**, **resource priorities**, and **expansion logic** comes from hands-on gameplay experience and debugging complex multi-creep interactions.

## 🚀 Current Implementation

### Core Systems

#### **Creep Roles** (9 specialized types)

- **🧑‍🌾 Harvesters**: Energy collection with source-specific assignments and balanced source distribution.
- **⚡ Upgraders**: Controller progression with invader defense fallback and dynamic energy sourcing.
- **🔨 Builders**: Multi-priority construction/repair with wall reinforcement and job queue visualization.
- **🔭 Scouts**: Automated exploration with danger avoidance, pathfinding, and room intelligence gathering.
- **🛡️ Defenders**: Ranged combat units with target switching logic and IFF (Identify Friend or Foe) system.
- **🔋 Suppliers**: Energy logistics with container balancing, link networks, and storage optimization.
- **🤖 Claimbots**: Room expansion units with global pathfinding and room claiming logic.
- **⚔️ Attackers**: Targeted combat units with console-orderable attacks and dynamic target assignment.
- **🌍 Remote Harvesters**: Long-distance energy collection with adaptive body scaling and hostile evasion.

#### **Defense & Infrastructure**

- **Advanced Tower Logic**: Smart targeting prioritizing healers, multi-level repair (creeps > structures > walls), and energy conservation.
- **Intelligent Link Network**: Classifies links as ```donor```, ```storage```, or ```recipient``` with energy distribution prioritization.
- **Road Tracking**: Real-time road usage monitoring with untraveled road visualization and overused path detection.

#### **Colony & Resource Management**

- **Dynamic Creep Scaling**: Tiered body definitions for each role based on room energy capacity.
- **Emergency Protocols**: Auto-spawns basic harvesters during energy crises and delays spawns during low energy.
- **Low-Energy Spawn Dampening**: Prevents harvester over-spawning when total energy is critically low.

#### **Performance & Analytics**

- **Granular CPU Profiling**: Per-function and per-role CPU tracking with caching to reduce ```find()``` calls.
- **Optimized Caching**: Memory-based structure/room data caching for reduced computation.
- **Energy Income Tracking**: 100-tick window energy rate calculations.
- **Controller Upgrade ETAs**: Real-time RCL progress estimation with time-to-complete formatting.
- **Daily Kill Counter**: Tracks creep kills via ```Game.events``` with daily reset.

### Development Approach

- Started with AI-generated boilerplate to understand the Screeps API.
- Defined custom operational rules and priority systems for all colony operations.
- Implemented and refined emergency modes and resource management logic.
- Continuously optimizing for CPU efficiency through caching and profiling.
- Iteratively improving combat and economic strategies based on live colony performance.

---

### New Features in Current Code

#### 🧠 Advanced Builder System

- **Job Queue Visualization**: Color-coded builder task tables showing real-time assignments.
- **Wall Build Optimization**: Distributes wall-building tasks across multiple builders.
- **Energy Acquisition Logic**: Prioritizes containers/storage over direct source harvesting.

#### 🗺️ Smart Pathfinding

- **Stuck Detection**: Automatic route recalculation when creeps are immobilized.
- **Danger Room Blacklisting**: Avoids hostile rooms and dynamically updates pathfinding.
- **Pathfinder Scouts**: Dedicated creeps for finding safe routes between rooms.

#### 🛠️ Remote Harvester Improvements

- **Dynamic Body Scaling**: Three-tier body definitions (600/1200/1800 energy cost).
- **Hostile Evasion**: Flee logic when encountering hostile creeps or towers.
- **Deposit Optimization**: Prioritizes local storage before using remote links.

#### 📊 Enhanced Analytics

- **CPU Usage Logging**: Detailed per-role CPU consumption tracking.
- **Energy Flow Visualization**: Color-coded supplier task tables with source/destination mapping.
- **Road Efficiency Metrics**: Identifies underused roads and overused open tiles.

#### 🛡️ Security Systems

- **IFF Module**: Whitelisted usernames for tower targeting logic.
- **Invader Defense**: Upgraders retreat to storage during hostile presence.
- **Claimbot Pathfinding**: Global route calculation with room blacklisting.

---

### Code Structure
