# ScreepsWorldGame

My evolving multi-room AI colony implementation for [Screeps: World](https://store.steampowered.com/app/464350/Screeps_World/), where JavaScript meets strategy gaming.

## 🎮 About

This repository contains the codebase that runs my Screeps colonies 24/7. While I've used AI tools to accelerate development, every strategic decision about **creep behavior**, **resource priorities**, and **expansion logic** comes from hands-on gameplay experience and debugging complex multi-creep interactions.

## 🚀 Current Implementation

### Core Systems

#### **Creep Roles** (7 specialized types)
- **🧑‍🌾 Harvesters**: Energy collection with source-specific assignments.
- **⚡ Upgraders**: Controller progression, with numbers scaling based on stored energy levels.
- **🔨 Builders**: Manages tasks with a sophisticated priority system (critical repairs > construction > container/road repair > wall reinforcement).
- **🔭 Scouts**: Automated exploration and room analysis.
- **🛡️ Defenders**: Combat units with ranged attack capabilities.
- **🔋 Suppliers**: Energy logistics between storage, links, and spawns.
- **🤖 Claimbots**: Room expansion units spawned via a global `claimOrders` queue.

#### **Defense & Infrastructure**
- **Advanced Tower Logic**: Smart targeting that prioritizes healers and uses an **IFF** (Identify Friend or Foe) module. It tracks damage dealt and switches targets if an attack is ineffective (e.g., being out-healed). Also performs multi-level repairs (creeps > structures > walls).
- **Intelligent Link Network**: Classifies links as `donor`, `storage`, or `recipient` based on proximity to sources, storage, and the controller. Energy is prioritized to controller links first, then distributed across the network.
- **Road Tracking**: Monitors road usage to identify and visualize inefficient paths.

#### **Colony & Resource Management**
- **Dynamic Creep Scaling**: Automatically builds larger, more effective creeps as the room's energy capacity increases, using a tiered body-part system for each role.
- **Emergency Protocols**: Spawns basic "crippled" harvesters when a room has zero harvesters to jump-start the economy.
- **Low-Energy Spawn Dampening**: Delays harvester spawns when total energy is critically low to allow for recovery.

#### **Performance & Analytics**
- **Granular CPU Profiling**: In-depth, per-function and per-role CPU profiling to identify performance bottlenecks.
- **Optimized Caching**: Reduces CPU load by caching structure IDs and room data in memory, minimizing expensive `find()` calls.
- **Energy Income Tracking**: Real-time energy generation rate calculations over a 100-tick window.
- **Controller Upgrade ETAs**: Estimates time to next RCL with day/hour/minute formatting.
- **Daily Kill Counter**: Tracks creep kills using `Game.events` and resets daily.
- **Per-Room Management**: Independent spawn queues, creep counts, and status dashboards for each owned room.

### Development Approach
- Started with AI-generated boilerplate to understand the Screeps API.
- Defined custom operational rules and priority systems for all colony operations.
- Implemented and refined emergency modes and resource management logic.
- Continuously optimizing for CPU efficiency through caching and profiling.
- Iteratively improving combat and economic strategies based on live colony performance.
