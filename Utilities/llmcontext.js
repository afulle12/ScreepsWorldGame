// LLM: Read llmcontext.js before reviewing or changing this file.
// llmcontext.js
// Pure documentation for LLM-based code review and generation.
// This file has NO runtime purpose. The entire body is inside a
// block comment, so if accidentally required the module is a no-op
// with zero memory cost from the documentation content.

/*
# LLM Context - Screeps Bot

## 1. Project identity

This is a Screeps bot. It runs on Shard 3 and automates gameplay:
mining, trading, defense, room management, lab reactions, factory
production, power harvesting, and more. The codebase has roughly 90
JavaScript modules (CommonJS). Each module file is self-contained.

This file (llmcontext.js) is pure documentation. It ships with the
bot so that an LLM reading the source directory can understand the
project's conventions, constraints, and architecture.

## 2. Runtime environment

- **Shard 3.** 20 CPU hard limit per tick.
- **Serialization tax:** ~1.5 CPU (measured at ~196KB Memory), paid only
  on memoryManager save ticks (1 in 10). calcTickBudget() reserves
  MEMORY_SAVE_RESERVE on those ticks; other ticks pay nothing.
- **Bucket tiers (defined as CPU budget):**
  - CRITICAL (bucket < 1000): aggressive shedding, keep economy alive.
  - LOW (1000-3000): interpolate between CRITICAL and NORMAL budgets.
  - NORMAL (3000-8000): standard operation.
  - FLUSH (> 8000): spend freely, burn bucket on low-frequency work.
- **CPU_LIMITS:** HARD_CEILING 19.3, NORMAL 18.0, CRITICAL 14.0.
- **Node version:** Screeps runs Node v24 (modern V8). All ES2024+ JS
  features are available.
- **Module system:** CommonJS only (module.exports, require). No ESM
  (no import, no export). No npm packages; only what Screeps provides
  in the global sandbox (Game, Room, Memory, etc.).
- **Execution model:** Everything runs in the Screeps cloud sandbox.
  There is no local development loop. Code is deployed and then runs
  server-side. No local tooling should be used.
- **Working directory:** This file lives in the bot's deployment
  directory. Do not navigate to parent directories, the user's home
  directory, Steam config, or anywhere else on the filesystem.

## 3. Module taxonomy

Files in this directory follow a naming convention that indicates
their role:

| Pattern | Purpose | Example |
|---------|---------|---------|
| roleXxx.js | Creep role. Exports run(creep) called each tick per creep, and optionally spawn() | roleHarvester.js, roleLabBot.js |
| xxxManager.js | Per-tick orchestrator. Often exports run() which main.js calls | spawnManager.js, terminalManager.js, labManager.js, towerManager.js |
| xxxProfiler.js | CPU profiling utilities | screeps-profiler.js, roomCPUProfiler.js |
| xxxQuery.js | Read-only data access, often registers a global for console use | marketQuery.js, memoryQuery.js |
| standalone xxx.js | Single-purpose module | iff.js, getRoomState.js, roomBalance.js |
| llmcontext.js | This file -- pure documentation | -- |

When adding new functionality:
- A new creep role -> roleXxx.js
- A new tick-time orchestrator -> xxxManager.js
- A new console query tool -> xxxQuery.js + register global in that file
- A standalone data module -> descriptive single word (e.g., iff.js)

## 4. Code style

- **File header:** First line is // filename.js. Second line is // Desc:
  or // Purpose: with a one-line description.
- **Exports:** CommonJS -- module.exports = { ... }. Named functions or
  objects.
- **Indentation:** 2 spaces. No tabs.
- **Variables:** const by default. let only when reassignment is
  required. var is legacy (seen in getRoomState.js but not preferred
  for new code).
- **Functions:** Named function declarations for top-level entries.
  Arrow functions for short inline helpers.
- **Comments:** No comments inside functions unless the behavior is
  genuinely non-obvious. A one-line header comment per module is
  sufficient.
- **No optional chaining:** Convention from getRoomState.js. Use
  explicit checks (if (obj && obj.prop)).
- **Return convention:** Many functions return Screeps result codes
  directly (OK, ERR_NOT_IN_RANGE, etc.). The helper
  isSuccess(result) in roomBalance.js checks against [OK, 0, true,
  'OK', 'queued'].

## 5. Logging convention

Logging is expensive (console output adds CPU). The pattern is:

- Declare a per-module LOG_INTERVAL constant (e.g., 5, 25, 250 ticks).
- Gate log calls: if (Game.time % LOG_INTERVAL === 0).
- Usually wrapped in a module-level log(message) helper.

Observed intervals:
- BUILDER_LOG_INTERVAL = 5 (roleBuilder.js)
- LOG_INTERVAL = 25 (roomCPUProfiler.js)
- ENERGY_LOG_INTERVAL = 250 (scanner.js)

For new modules, declare your own interval. Do not reuse another
module's LOG_INTERVAL unless the cadence is intentionally shared.

## 6. Profiling and CPU budget

- screeps-profiler is opt-in. main.js enables it only when
  Memory.settings.screepsProfiler is truthy. Toggle with profilerOn()
  and profilerOff(); changes take effect after the next global reset.
  New functions can be profiled by wrapping them with
  profiler.registerFN().
- main.js defines a SECTION_TIER map that assigns every schedulable
  section a priority: CRITICAL (3), HIGH (2), NORMAL (1), LOW (0).
- When the CPU bucket is low, the scheduler sheds LOW and then NORMAL
  work, keeping CRITICAL and HIGH running.
- New work that runs every tick (or every N ticks via the scheduler)
  must be added in two places:
  1. Its function in the relevant module.
  2. A SECTION_TIER entry in main.js so the scheduler knows its
     priority.

## 7. Memory hygiene

Memory is heap-backed via memoryManager.js. main.js calls
memoryManager.run() first thing every tick; it reuses the parsed Memory
object across ticks (no per-tick JSON.parse) and only serializes to the
persistent store every SAVE_INTERVAL (10) ticks. Consequences:

- **A global reset rolls Memory back to the last save** (up to 9 ticks).
  Mutations that cannot afford to be lost must be followed by
  memoryManager.requestSave() in the same tick.
- **The save cadence is aligned with spawnManager's 10-tick cadence** so
  new creep memory persists the tick it is written. Do not change one
  interval without the other.
- **Client Memory-UI edits are never read** and get clobbered on the
  next save tick. Run memoryReload() in the console after such edits.
- Serialization costs ~1.5 CPU (at ~196KB Memory) on save ticks only.
- **Transient state belongs in memoryManager.heap, not Memory.** Get it
  with require('memoryManager').heap. It persists across ticks on the
  heap, is never serialized, and is empty after every global reset.
  Current residents: heap.cpuStats, heap.cpuProfile,
  heap.cpuProfileLastUsed, heap.cpuProfileCreeps, heap.roomEffProfile.
  Only put data here whose loss on reset is acceptable (telemetry,
  profiling windows, recomputable caches).

Principles to keep serialization lean:

- **Store only what is read.** Every key in Memory is serialized.
- **Prefer recomputation over storage.** Derived values (e.g., number
  of mineral X across all rooms) should be recomputed from source
  data rather than stored.
- **Prune aggressively.** If a creep dies, delete its memory entry.
  Delete stale room state, obsolete orders, etc.
- **Know your readers.** Before adding a new Memory field, grep the
  codebase for code that reads it. If nothing reads it, do not add it.
- **No full Memory schema is documented here.** The Memory structure
  is distributed across the modules that own each area. To understand
  what a field is, read the module that writes and reads it.
- **Do not persist derived state.** If a value can be computed from
  Game.creeps, Game.rooms, or Game.market, compute it each tick.

## 8. Screeps API pointer

The official Screeps API documentation is at:

    https://docs.screeps.com/api/

The objects and methods used most heavily in this bot include:

- Game.creeps, Game.rooms, Game.spawns, Game.time, Game.market,
  Game.flags
- Room.find() -- but use getRoomState instead (see section 10)
- Room.controller, Room.storage, Room.terminal
- Creep: store, memory, moveTo, harvest, transfer, withdraw, drop,
  pickup, build, repair, upgradeController, attack, rangedAttack,
  heal, getActiveBodyparts
- StructureSpawn: spawnCreep, store
- StructureTerminal: send, store
- StructureStorage: store
- StructureLab: runReaction, store, mineralType
- StructureFactory: produce, store
- StructureTower: attack, heal, repair, store
- StructureRampart: hits, hitsMax, isPublic
- StructureLink: transferEnergy, store
- StructureWall: hits, hitsMax
- Mineral: mineralType, mineralAmount, density
- Source: energy, energyCapacity, ticksToRegeneration
- ConstructionSite: structureType, progress, progressTotal, pos
- Market: getAllOrders, createOrder, deal, cancelOrder, getHistory
- Ownership: creep.my, structure.my, room.controller.my
- RoomObject: pos, room
- RoomPosition: roomName, x, y, findClosestByRange,
  findClosestByPath, getRangeTo, isNearTo, isEqualTo,
  createConstructionSite
- PathFinder: use, PathFinder.search, PathFinder.CostMatrix
- RawMemory: setActiveSegments, segments, setPublicSegments, get, set
- Inter-shard: InterShardMemory
- Constants: FIND_*, RESOURCE_*, ORDER_BUY, ORDER_SELL, OK, ERR_*,
  LOOK_*, BODYPART_*, WORK, CARRY, MOVE, ATTACK, RANGED_ATTACK, HEAL,
  TOUGH, CLAIM

When you need to access game data, follow the lookup order in
section 10.

## 9. Console globals

The following functions are registered on the global object for use
in the Screeps console (or for internal cross-module access):

| Global | Defined in | Purpose |
|--------|-----------|---------|
| marketPrice(resource, mode) | marketQuery.js | Query market prices (avg, buy, sell) |
| prices(resource?, sortBy?) | marketPricing.js | Market dashboard: weighted mid-prices, spreads, depth (external orders only) |
| memoryQuery(path) | memoryQuery.js | Inspect Memory at a dot path; prints sub-tree when path resolves |
| memoryQueryKeys(path) | memoryQuery.js | Keys of a Memory sub-object |
| memoryQueryValues(path) | memoryQuery.js | Values of a Memory sub-object |
| memoryGet(path) | memoryQuery.js | Get a Memory value safely |
| memoryPrint(path) | memoryQuery.js | Force-print a Memory path (no search fallback) |
| memoryOverview() | memoryQuery.js | Top-level Memory key sizes |
| memoryProfile(path?) | memoryQuery.js | Memory (or subtree) size breakdown + stringify CPU cost |
| marketMap | marketMap.js | Room-to-order map object |
| launchClaimbot(roomName) | roleClaimbot.js | Spawn a claim creep for a target room |
| launchNuke(donor, recipient, structType) | nukeLaunch.js | Fire a nuker at a structure type in a room |
| nukeStatus(playerName?) | nukeLaunch.js | Nuker cooldown/E/G report; own rooms, or a player's rooms via observer scan |
| nukeStatusCancel() | nukeLaunch.js | Abort an active player nuker scan |
| memorySave() | memoryManager.js | Force heap Memory serialization to the persistent store this tick |
| memoryReload() | memoryManager.js | Discard heap Memory and re-parse from the persistent store next tick |
| status(playerName?) | statusReport.js | No arg: colony status board. With a player name: observer-scan that player's registry rooms via scanner and print an enemy status board |
| orderThieves(targetRoom) | roleThief.js | Send thieves to a room |
| cancelThiefOrder(orderId) | roleThief.js | Cancel a thief order |
| listThiefOrders() | roleThief.js | List active thief orders |

The IFF whitelist is in iff.js as the IFF_WHITELIST constant. Check
isHostileCreep(creep) and isFriendlyUsername(username) before making
hostility decisions.

**Rule:** New globals must be registered in the module that owns the
feature, not in main.js. main.js should only do require() for side
effects. See marketQuery.js (side-effect-only file, no module.exports)
as a reference.

## 10. Architecture and boot order

- main.js is the single entry point per tick. It requires() every
  other module at boot (first require loads, subsequent requires
  return cached exports). Some requires are purely for side-effect
  global registration.
- The profiler (screeps-profiler) wraps the main loop.
- The CPU scheduler decides which sections run based on bucket level
  and SECTION_TIER priority.
- Tick execution order (simplified): memoryManager (heap Memory swap,
  always first), room state init, defense, towers, links, terminals,
  labs, spawning, market, creeps, scans, cleanup.

### Data access hierarchy

When you need to access game world data, follow this order:

1. **getRoomState** (getRoomState.js) -- the primary cached room-state
   module. Call getRoomState.get(roomName) or getRoomState.all().
   **Ownership source of truth:** for claimed/owned-room decisions, use
   getRoomState.isOwned(roomName), getRoomState.owned(), or
   getRoomState.ownedNames(). Do not infer ownership from
   getRoomState.get(roomName), getRoomState.has(roomName),
   getRoomState.all(), Memory room-keyed data, or visibility in Game.rooms.
   getRoomState caches owned rooms plus visible rooms where our creeps/power
   creeps are present, so an unclaimed room like E3N45 can still have room
   state without being owned.
   Returns an object with these pre-computed fields:
   - controller, storage, terminal
   - myCreeps (array), hostiles, dropped, tombstones, ruins
   - sources, minerals, constructionSites
   - structuresByType (grouped by structureType)
   Each field is cached independently with its own TTL (1-500 ticks).
   Never mutate the returned arrays. Never cache the result across
   ticks.

2. **xxxQuery.js modules** -- marketQuery.js for market data,
   memoryQuery.js for Memory introspection.

3. **Raw Game API** -- Only as a last resort if no helper exists, or
   for rooms outside our claimed rooms where getRoomState is not the
   right source of truth.

**room.find() convention:** use getRoomState for claimed rooms. Direct
room.find() should normally be limited to getRoomState itself or code
operating outside our claimed rooms. If a claimed-room module needs
room.find() for a special live-data case, document why in that module.

### Spawning

All spawning flows through spawnManager.js. The entry point is:

    spawnManager.run(perRoomRoleCounts)

New spawn capability should be added as a manageXxxSpawns function in
spawnManager.js, then exported from its module.exports block (which
currently contains roughly 30 manage functions).

Never call Game.spawns[name].spawnCreep() from outside
spawnManager.js.

### Major subsystems

- **scanner.js** is the central intel and observer subsystem. It owns
  room intel, player scans, nuke analysis, wide scans, war estimates,
  the room registry, and observer scheduling. Other modules should
  request observer work through require('scanner').observe.request()
  instead of directly controlling observers.

- **storageManager.js** is the shared reservation ledger for stored
  resources. Terminal, factory, lab, market, and transfer code should
  reserve resources here before moving them so systems do not fight
  over the same minerals or energy. Key Memory owner:
  Memory.storageReservations.

- **terminalManager.js** owns cross-room terminal logistics and terminal
  busy-state decisions. Prefer its transfer commands/helpers instead
  of ad hoc terminal.send() calls.

- **labManager.js** owns reaction orders and lab layout. **boostManager.js**
  owns boost orders and role boost state. Do not mix reaction, boost,
  and market-lab state unless the owning module exposes an API for it.

- **factoryManager.js** owns commodity production orders. Factory work
  should go through orderFactory/cancelFactoryOrder style commands, not
  one-off factory.produce() calls from unrelated modules.

- **repairManager.js** owns unified repair planning, repair spawn
  requests, and nuke repair planning. Legacy repair roles still exist,
  but new repair orchestration should integrate with repairManager.
  Rampart targets/caps are configurable consts at the top of
  repairManager.js, exported via repairManager.constants (used by
  towerManager, roleRepairer) — never redefine them.

- **roomSuspender.js** is a CPU-shedding system for low-risk rooms. It
  can suspend room-local work while keeping critical systems such as
  defense, scans, and market work alive. Respect its state before adding
  new per-room recurring work.

- **taskScheduler.js** persists console commands in Memory and re-runs
  them every N ticks. It intentionally evals scheduled command strings.
  Globals: schedule, unschedule, listScheduled, runScheduled,
  updateScheduled. Key Memory owner: Memory.taskScheduler.

- **powerManager.js** and **roleOperator.js** own power processing and
  power-creep/operator setup. Operator state is separate from normal
  creep role state and uses Memory.operators and related source-regen
  Memory keys.

- **market*.js modules** own market automation. Important convention:
  Game.market.createOrder() returns OK but does not synchronously expose
  the new order id; managed market modules track pending/order state in
  Memory and reconcile on later ticks.

- **marketPricing.js is the single source of truth for market price
  computation.** Any module that needs a market price must call its API
  (getAvg48h, getBook, actualBuyPrice, actualSellPrice, computePostedBid,
  inputCeilings, chooseBuyMethod, getHistDays) instead of hand-rolling
  averages from Game.market.getHistory() or scanning the order book.
  Its book is external-only, dust-filtered (remaining >= 1000), and
  cached per tick on top of util.marketSnapshot(). getAvg48h returns
  null with no history -- callers supply their own fallback.
  Documented exceptions (do NOT consolidate; see the file comments):
  marketAnalysis.js's self-contained price helpers (different return
  shapes, intentionally independent) and marketArbitrage.js's
  capByEnergy (power-creep-aware effective-cost model). Realized
  averages computed from our own transaction logs (marketReport.js
  income/expense stats) are bookkeeping, not market pricing, and are
  fine.

## 11. Do and Don't -- hard rules

These are non-negotiable. Code that violates them will be rejected.

### DO

- Use getRoomState.get(roomName) or .all() instead of room.find() for
  claimed rooms.
- Route all spawning through spawnManager.js.
- Register new globals in the file that owns the feature; main.js only
  does require() for side effects.
- Gate expensive work with if (Game.time % N === 0).
- Add new modules to the taxonomy (roleXxx.js / xxxManager.js /
  xxxQuery.js).
- Add every creep role to statusReport.js so status() includes an entry
  for that role in both per-room counts and total creep counts.
- Check creep.memory.role before doing role-specific lookups.
- Declare a SECTION_TIER in main.js for new schedulable work.
- Copy the IFF_WHITELIST pattern from iff.js when adding player-lists.
- Route all market price computation through marketPricing.js
  (getAvg48h, getBook, actualBuyPrice, actualSellPrice, ...).
- Delete creep memory when a creep dies.
- Keep template literal bodies free of dollar-brace and backslash.

### DON'T

- Do not use room.find() in claimed-room code except inside
  getRoomState or for a documented special live-data case.
- Do not call Game.spawns[name].spawnCreep() outside spawnManager.js.
- Do not add global.X = ... lines to main.js. Put them in the owning
  module.
- Do not cache getRoomState output across ticks. It is per-tick.
- Do not mutate anything returned by getRoomState. Arrays are shared.
- Do not add Memory fields speculatively. Grep for readers first.
- Do not call Game.market.getHistory() or scan the order book to
  compute a price outside marketPricing.js. The only sanctioned
  exceptions are listed in the marketPricing bullet in section 10.
- Do not leave this directory. All bot code is in the same directory
  as this file.
- Do not run anything locally. No node, npm, screeps-cli, or any
  other tool.
- Do not require() this file from any other module.
- Do not introduce ESM syntax (import, export) -- CommonJS only.
- Do not invent global.* names without adding them to section 9 of
  this file.
- Do not add comments inside functions unless the behavior is
  non-obvious.
*/
