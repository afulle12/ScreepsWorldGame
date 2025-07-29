# ScreepsWorldGame

An advanced, evolving multi-room AI colony implementation for [Screeps: World](https://store.steampowered.com/app/464350/Screeps_World/), blending JavaScript with strategic gameplay. This repository manages autonomous Screeps colonies that operate 24/7, leveraging AI-assisted development while prioritizing human-driven strategies for creep behavior, resource management, and expansion.

## 🎮 About

This codebase powers my Screeps colonies, drawing from AI tools for rapid prototyping while ensuring all core decisions—such as creep roles, resource allocation, and defensive tactics—are refined through extensive gameplay testing and debugging. The system handles complex interactions across multiple rooms, focusing on efficiency, scalability, and adaptability to in-game challenges.

Key enhancements in the current version include improved creep pathfinding, dynamic body scaling for remote harvesters, and enhanced analytics for better performance tracking. The code emphasizes CPU optimization through caching and profiling, ensuring smooth operation even in high-stakes scenarios.

## 🚀 Current Implementation

### Core Systems

#### **Creep Roles** (9 Specialized Types)

This section outlines the core creep roles, now updated with advanced behaviors from the new code:

- **🧑‍🌾 Harvesters**: Focus on energy collection with source-specific assignments and balanced distribution. New optimizations include efficient harvesting logic that reduces `find()` calls via caching.
- **⚡ Upgraders**: Handle controller upgrades with fallback to invader defense. Dynamic energy sourcing ensures upgraders pull from cached sources, improving efficiency.
- **🔨 Builders**: Multi-priority construction and repair, including wall reinforcement and job queue visualization. The advanced builder system introduces color-coded task tables, distributed wall-building tasks, and energy acquisition logic prioritizing containers over direct sources.
- **🔭 Scouts**: Automated exploration with danger avoidance and pathfinding. Smart pathfinding enhancements include stuck detection, room blacklisting, and dedicated pathfinder scouts for safe routes.
- **🛡️ Defenders**: Ranged combat with target switching and IFF systems. Improved patrol logic features stuck detection, random movement for evasion, and strategic points around key structures.
- **🔋 Suppliers**: Energy logistics with container balancing and link networks. Tasks are now optimized with per-tick caching for faster assignment and logging.
- **🤖 Claimbots**: Room expansion with global pathfinding and blacklisting. Enhanced logic includes intelligent movement to avoid edges and handle hostiles.
- **⚔️ Attackers**: Combat units with console-orderable attacks. They use IFF modules to avoid friendlies and prioritize targets, with pathfinding to break through walls.
- **🌍 Remote Harvesters**: Long-distance energy collection with adaptive body scaling (three tiers: 600/1200/1800 energy cost), hostile evasion, and deposit optimization favoring local storage.

#### **Defense & Infrastructure**

- **Advanced Tower Logic**: Prioritizes healers, repairs creeps and structures, and conserves energy. Includes IFF whitelisting for accurate targeting.
- **Intelligent Link Network**: Classifies links as donor, storage, or recipient, with energy distribution based on thresholds (e.g., fill if below 400 energy).
- **Smart Pathfinding**: Integrated into scouts and other roles, with stuck detection and dynamic room blacklisting to avoid hostiles.
- **Road Tracking**: Monitors usage and detects overused paths, aiding in efficient creep movement.

#### **Colony & Resource Management**

- **Dynamic Creep Scaling**: Tiered body definitions based on room energy, with emergency protocols for low-energy states.
- **Emergency Protocols**: Auto-spawns harvesters during crises and delays spawns when energy is critically low.
- **Low-Energy Spawn Dampening**: Prevents over-spawning to maintain stability.

#### **Performance & Analytics**

- **Granular CPU Profiling**: Tracks per-function and per-role usage, with options to toggle logging.
- **Optimized Caching**: Reduces computation by caching room and structure data.
- **Energy Income Tracking**: Calculates rates over a 100-tick window.
- **Controller Upgrade ETAs**: Provides real-time estimates with formatted time-to-complete.
- **Daily Kill Counter**: Monitors creep kills via game events.
- **Enhanced Analytics**: Includes CPU usage logging, energy flow visualization with color-coded tables, and road efficiency metrics for underused paths.

### New Features

The latest code updates introduce significant improvements:

- **🧠 Advanced Builder System**:
  - Job queue visualization with color-coded tables for real-time assignments.
  - Wall build optimization distributes tasks across builders.
  - Energy acquisition prioritizes containers and storage over direct harvesting.

- **🗺️ Smart Pathfinding**:
  - Stuck detection triggers route recalculation.
  - Danger room blacklisting dynamically updates to avoid hostiles.
  - Pathfinder scouts dedicate creeps to finding safe inter-room routes.

- **🛠️ Remote Harvester Improvements**:
  - Dynamic body scaling with tiers (600/1200/1800 energy cost).
  - Hostile evasion logic for fleeing from creeps or towers.
  - Deposit optimization prioritizes local storage before remote links.

- **📊 Enhanced Analytics**:
  - CPU usage logging tracks per-role consumption.
  - Energy flow visualization with color-coded supplier task tables.
  - Road efficiency metrics identify underused roads and overused tiles.

- **🛡️ Security Systems**:
  - IFF module with whitelisted usernames for tower targeting.
  - Invader defense makes upgraders retreat during threats.
  - Claimbot pathfinding incorporates global routes and room blacklisting.

### Development Approach

Development began with AI-generated boilerplate for Screeps API familiarity, followed by custom rules for operations. Emergency modes and resource logic have been refined, with ongoing optimizations for CPU efficiency. Combat and economic strategies are iteratively improved based on live performance, incorporating the new features for better adaptability.