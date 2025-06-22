# ScreepsWorldGame

My evolving multi-room AI colony implementation for [Screeps: World](https://store.steampowered.com/app/464350/Screeps_World/), where JavaScript meets strategy gaming.

## 🎮 About

This repository contains the codebase that runs my Screeps colonies 24/7. While I've used AI tools to accelerate development, every strategic decision about **creep behavior**, **resource priorities**, and **expansion logic** comes from hands-on gameplay experience and debugging complex multi-creep interactions.

## 🚀 Current Implementation

### Core Systems

#### **Creep Roles** (7 specialized types)
- **🧑‍🌾 Harvesters**: Energy collection with source-specific assignments
- **⚡ Upgraders**: Controller progression with room targeting
- **🔨 Builders**: Construction site management
- **🔭 Scouts**: Automated exploration and room analysis
- **🛡️ Defenders**: Combat units with ranged attack capabilities
- **🔋 Suppliers**: Energy logistics between storage structures
- **🤖 Claimbots**: Room expansion units

#### **Defense & Infrastructure**
- **Tower Logic**: Smart targeting system that prioritizes healers and switches targets when damage stalls
- **Link Network**: Automated energy transfer between storage and controller links
- **Road Tracking**: Monitors road usage to identify inefficient paths

#### **Performance & Analytics**
- **CPU Tracking**: Rolling average CPU usage monitoring
- **Energy Income**: Real-time energy generation rate calculations
- **Progress ETAs**: Controller upgrade time estimates with day/hour/minute formatting
- **Per-Room Management**: Independent spawn queues and creep counts for each room

### Development Approach
- Started with AI-generated boilerplate to understand Screeps API
- Defined custom operational rules and priority systems
- Implemented emergency modes (e.g., spawning crippled harvesters when energy-critical)
- Added 60-tick spawn delays to prevent energy depletion
- Continuously refining based on colony performance
