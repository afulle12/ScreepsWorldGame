// LLM: Read docs/codex.js before reviewing or changing this file.
// docs/codex-full.js
// Pure documentation for LLM-based code review and generation.
// This file has NO runtime purpose. The entire body is inside a
// block comment, so if accidentally required the module allocates no documentation data structures at runtime.

/*
Codex - Screeps Bot

1. Project identity

This is a Screeps bot. It runs on Shard 3 and automates gameplay:
mining, trading, defense, room management, lab reactions, factory
production, power harvesting, and more. The codebase is a collection of
self-contained JavaScript modules using CommonJS.

This file (codex-full.js) is the long-form companion to docs/codex.js. It is
documentation only and is not deployed or loaded by the Screeps runtime. An
LLM reading the source directory can use it for the project's conventions,
constraints, and architecture.

2. Runtime environment

- Shard 3. The per-tick CPU limit is 20.
- Serialization tax: paid only when memoryManager saves. The manager
  periodically measures JSON.stringify(Memory), and the scheduler reserves
  its amortized cost across the save interval.
- Bucket tiers (defined as CPU budget):
  - CRITICAL (bucket < 1000): aggressive shedding, keep economy alive.
  - LOW (1000-2999): reserve amortized serialization plus 3 CPU.
  - NORMAL (3000-7999): reserve amortized serialization plus 1 CPU.
  - FLUSH (8000-10000): reserve amortized serialization plus 0.1 CPU.
- CPU budgets subtract amortized serialization and a total tier buffer from
  the CPU limit. CRITICAL reserves 7 CPU, LOW 3, NORMAL 1, and FLUSH 0.1;
  these buffers are not cumulative.
- Node version: Screeps runs Node v24 (modern V8). All ES2024+ JS
  features are available.
- Module system: Production code uses CommonJS only (module.exports,
  require). No ESM (no import, no export) or npm packages are deployed;
  production code uses what Screeps provides in the global sandbox
  (Game, Room, Memory, etc.).
- Execution model: Production code runs in the Screeps cloud sandbox.
  There is no faithful local full-game emulator. The repository also
  contains dependency-free Node mock/regression harnesses; local execution
  is limited to those mocks and syntax checking. Deployment and runtime
  validation must occur in-game.
- Local tests run from this directory:

      NODE_PATH=. node test/test_harness.js
      NODE_PATH=. node test/market_harness.js
      NODE_PATH=. node test/terminal_recovery_harness.js
      NODE_PATH=. node test/market_sell_harness.js
      NODE_PATH=. node test/opportunistic_buy_harness.js
      NODE_PATH=. node test/role_builder_winddown_harness.js
      NODE_PATH=. node test/boost_order_capture_harness.js
      NODE_PATH=. node test/repair_manager_harness.js
      NODE_PATH=. node test/room_navigation_harness.js
      NODE_PATH=. node test/scavenger_deposit_harness.js
      NODE_PATH=. node test/scavenger_neural_harness.js
      NODE_PATH=. node test/spawn_repairer_harness.js

  `test/test_harness.js` covers storage-manager reservations and VFS behavior.
  `test/market_harness.js` covers market utilities, pricing, credit tracking,
  market economics, and sell policy. `test/terminal_recovery_harness.js`
  covers stale terminal-gather recovery and restaging. `test/market_sell_harness.js`
  covers direct market-sell pricing contracts. `test/opportunistic_buy_harness.js`
  covers pending opportunistic-buy reconciliation and transaction confirmation.
  `test/role_builder_winddown_harness.js` covers low-TTL builder winddown and
  deposit behavior. `test/boost_order_capture_harness.js` covers boost-order
  capture and body planning. `test/repair_manager_harness.js` covers repair
  task retention and dispatch. `test/room_navigation_harness.js` covers
  route and edge-navigation behavior. `test/scavenger_deposit_harness.js`
  covers deposit scoring and assignment. `test/scavenger_neural_harness.js`
  covers scavenger policy learning. `test/spawn_repairer_harness.js` covers
  queued repairer request retention. NODE_PATH makes Screeps-style bare module
  names resolvable.
  These tests use mocks or stubs and do not replace in-game integration testing.
  `node --check file.js` performs syntax-only validation.
- In-game validation includes deployment, LOW and CRITICAL bucket checks,
  `profileFor(ticks?, filter?)`, and subsystem-specific checks such as
  `flagVault.test(1024)`.
- Working directory: This file lives in the bot's deployment
  directory. Do not navigate to parent directories, the user's home
  directory, Steam config, or anywhere else on the filesystem.
  Stay in the current working directory unless the user explicitly
  asks you to navigate elsewhere.

3. Module taxonomy

Files in this directory follow a naming convention that indicates
their role:

- roleXxx.js: Creep role. Exports run(creep) called each tick per creep, and optionally spawn()
  Examples: roleHarvester.js, roleLabBot.js
- xxxManager.js: Per-tick orchestrator. Often exports run() which main.js calls
  Examples: spawnManager.js, terminalManager.js, labManager.js, towerManager.js
- xxxProfiler.js: CPU profiling utilities
  Examples: screeps-profiler.js, roomCPUProfiler.js
- xxxQuery.js: Read-only data access, often registers a global for console use
  Examples: marketQuery.js, memoryQuery.js
- standalone xxx.js: Single-purpose module
  Examples: iff.js, getRoomState.js, roomBalance.js
- xxxSlots.js: Shared operation-capacity accounting and refusal helpers;
  factorySlots.js counts live refine/factory work and avoids double-counting
  linked factory orders.
- xxxLedger.js: Small accounting state shared by multiple callers;
  creditLedger.js tracks committed market credit spend within the current tick.
- xxxPolicy.js: Shared policy predicates and derived limits;
  labCommodityPolicy.js owns two-letter lab-product and five-unit reaction
  quantity rules, while autoTraderSellPolicy.js owns configured and derived
  minimum sell-price floors.
- xxxPipeline.js: Pure planning and validation helpers;
  labReactionPipeline.js builds and validates multi-stage synthesis or
  decomposition graphs and provides a self-test.
- xxxRouter.js: A bounded nested worker for queueing and routing;
  labCommodityRouter.js chooses direct, forward, or reverse routes for
  restricted lab inventory, manages reservations, and starts or settles
  conversions.
- compliance.js: Console-facing reports and corrective actions for spawn-model,
  room-layout, and rampart compliance.
- docs/codex.js: Concise project guide for review and generation
- docs/codex-full.js: This file -- long-form project documentation

The slots, ledger, policy, pipeline, router, and compliance modules are
libraries, console utilities, or nested workers rather than independent
scheduler sections. Their work inherits the scheduler section that calls them.

When adding new functionality:
- A new creep role -> roleXxx.js
- A new tick-time orchestrator -> xxxManager.js
- A new console query tool -> xxxQuery.js + register global in that file
- A standalone data module -> descriptive single word

4. Code style

- File header (preferences, not strict requirements):
  - Line 1: // LLM: Read docs/codex.js before reviewing or changing this file.
  - Line 2: should reference the filename (e.g. // filename.js or // === filename.js ===)
  - Subsequent lines: a short description of the module's purpose.
- Exports: CommonJS -- module.exports = { ... }. Named functions or objects.
  Side-effect-only console modules may omit module.exports.
- Indentation: 2 spaces. No tabs.
- Variables: const by default. let only when reassignment is
  required. var is legacy (seen in getRoomState.js but not preferred
  for new code).
- Functions: Named function declarations preferred for top-level entries.
  Arrow functions for short inline helpers.
- Comments: Inside-function comments are acceptable when explaining
  state transitions, performance decisions, invariants, or engine
  behavior. Avoid obvious or redundant comments.
- Return convention: Many functions return Screeps result codes
  directly (OK, ERR_NOT_IN_RANGE, etc.). The helper
  isSuccess(result) in roomBalance.js checks against [OK, 0, true,
  'OK', 'queued'].

5. Logging convention

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

6. Profiling and CPU budget

- screeps-profiler is always initialized so profileFor(ticks?, filter?) can
  start immediately. Captures stop and print automatically after ticks
  (default 100); use a function-name string as filter to limit the report.
  Registered functions retain a small wrapper cost even when no capture is
  active. New functions can be profiled by wrapping them with
  profiler.registerFN().
- main.js defines two execution modes:
  - profileSection: pressure- and cost-throttled work with a SECTION_TIER
    priority. CRITICAL runs every tick. HIGH/NORMAL/LOW first stretch
    dynamically up to 2/3/5 ticks as CPU pressure rises. Their measured
    per-run EWMA/decaying peak can additionally impose bounded minimum
    intervals of 2/5/10 ticks so an expensive section fits its tier's
    amortized CPU share. FLUSH bypasses this cost-only interval while retaining
    each section's explicit base cadence. Its late pass may run one section up
    to 50% of the CPU limit over budget, bounded by bucket CPU above the refill
    target, so indivisible work does not waste a nearly full bucket. Pressure
    and cost constraints combine into one elapsed-time interval after the
    initial hash-based stagger. Predicted
    budget overruns accrue retry debt and are retried on following ticks;
     expired debt may bypass its tier soft limit but never the CPU reserved for
     CRITICAL sections that have not run yet. After all profileSection call
     sites, the oldest hard-aged debt is eligible to run once per tick (outside
     CRITICAL bucket mode). A debt item can remain pending when its estimated
     work does not fit current CPU or bucket constraints; hard aging is not an
     unconditional delivery guarantee.
     Cost history and retry state are heap-only in heap.cpuSectionStats.
     A section listed in SECTION_CPU_SLICES receives its cooperative CPU
     allowance as the callback argument; it must yield only at a safe boundary.
     Every profileSection name must exactly match a SECTION_TIERS entry.
     Missing entries silently default to NORMAL tier but produce an undefined
     name hash, potentially causing the section to stall under pressure. Only
     the exact name passed at the profileSection call site is registered; a
     helper called inside that callback does not create another section.
   - measureSection: always-runs work that is measured but not
     scheduler-throttled, such as taskScheduler and serialization maintenance.
     measureSection itself does not throttle, defer, or assign a tier; an
     explicit call-site or module cadence guard can still prevent the call.
     Current measured work includes cpuTickLog, memoryMaintenance,
     dailyFinance.boundary, statusReport.getPerRoomRoleCounts,
     storageVfs.migration, storageVfs.maintenance, simscanQuery.run,
     flagVault.tick (which calls memoryManager.storage.tick()),
     marketEconomics.run, marketEconomics.archiveTick, and
     marketEconomics.archiveRetention, plus pending reconciliation,
     power/room/task maintenance, and serialization/CPU telemetry. The
     marketEconomics.run call site is guarded to every 10 ticks.
     scanner is an ALWAYS_RUN subsystem but deliberately bypasses both wrappers;
     it manages its own durable plan and reports phase costs to the scheduler.
- New profileSection work needs:
  1. Its function in the relevant module.
  2. A SECTION_TIER entry in main.js.
- New measureSection work needs no tier entry but needs justification.

7. Scheduler-compatible modules

The adaptive scheduler may skip a profileSection invocation for multiple
ticks. Under sustained load, HIGH, NORMAL, and LOW work can be deferred for
up to 10, 25, and 50 ticks respectively. A module must be classified before
it is added to main.js:

- CRITICAL: must issue intents or maintain state every tick. It belongs in a
  CRITICAL profileSection and must remain bounded. Examples: towers, spawn
  management, defense monitoring, and core creep dispatch.
- Tower-filler spawning is nested in spawn management: spawnManager.run calls
  spawnManager.manageTowerFillerSpawns (with its internal 10-tick gate), and
  tower-filler creeps dispatch through runCreeps to roleTowerFiller. There is
  no separate tower-filler profile section; the scheduler sees spawnManager.run
  and runCreeps.
- ADAPTIVE: can safely run after an arbitrary gap. It belongs in a named,
  tiered profileSection and must use durable state to resume its work.
- SLICED: adaptive work that may be expensive. It accepts the optional CPU
  allowance passed by profileSection, checks it at safe boundaries, and
  persists a cursor before returning.
- ALWAYS_RUN: essential bounded work that cannot defer. It uses
  measureSection only with an explicit comment explaining why adaptive
  scheduling is unsafe.

Adaptive-module contract:

- Never use Game.time % N as a correctness gate inside an adaptive module.
  A deferred call can miss the exact tick indefinitely. Persist lastRun or
  nextRun and run on the first invocation at or after the due tick instead.
- Treat every invocation as overdue. State transitions, transactions, spawn
  requests, construction-site creation, terminal sends, and market actions
  must be idempotent or protected by durable pending state before the action.
- Do not require an observer result, a structure cooldown, or another module
  to be processed on the immediately following tick. Check current state and
  elapsed deadlines whenever the module resumes.
- Do not place direct per-tick defense, economy, or creep intents in an
  adaptive manager. Keep those intents in CRITICAL paths, or explicitly
  accept reduced throughput as part of the section's tier.
- Bound each invocation. Full scans across rooms, orders, creeps, structures,
  or graph searches need a durable cursor or a documented, small maximum.
- A module must tolerate dependent adaptive modules being delayed separately;
  consume current durable state rather than relying on call order or cadence.

Sliced-module contract:

- Accept the optional cpuAllowance argument. An omitted allowance means the
  caller has not assigned a cooperative slice and must not change behavior.
- Derive a deadline from Game.cpu.getUsed() and cpuAllowance, then check it
  only between complete, retry-safe work units.
- Persist the next work cursor before returning. Never yield halfway through
  an irreversible action or before recording its deduplication state.
- Keep one work unit bounded. Do not begin an unbounded room, order-book, or
  pathfinding pass after the deadline is reached.

Registration checklist for new work:

1. Give every profileSection call an exact SECTION_TIERS entry. Missing names
   can break initial stagger calculation under pressure.
2. Use profileSection only after the module meets the ADAPTIVE contract.
3. Add SECTION_CPU_SLICES only after the module meets the SLICED contract.
4. Use measureSection only for bounded ALWAYS_RUN work, and document the
   reason it cannot be deferred.
5. Add a base interval only for a minimum cadence; the module must still run
   correctly when its invocation is late.

Validation checklist:

- Test the module after simulated 2-tick, 10-tick, and tier hard-limit gaps.
- Verify repeated overdue calls cannot duplicate market deals, terminal sends,
  spawn requests, construction sites, factory actions, or nuke launches.
- Validate behavior with LOW and CRITICAL bucket conditions in-game.
- Inspect cpuJSON() for expensive, repeatedly deferred, or permanently
  pending sections before promoting a module to a higher tier.

Scheduler anti-patterns:

- Exact Game.time modulo gates in profileSection modules.
- Unbounded full-world scans without resumable progress.
- Assuming a manager runs immediately before its dependent creep role.
- Delaying direct defense or core-energy intents without accepting the loss of
  action ticks.

8. Memory hygiene

Memory is heap-backed via memoryManager.js. main.js calls
memoryManager.run() first thing every tick; it reuses the parsed Memory
object across ticks (no per-tick JSON.parse) and only serializes to the
persistent store at dirty scheduled checkpoints (normally every SAVE_INTERVAL,
10, ticks) or on explicit immediate saves. Consequences:

- A global reset rolls Memory back to the last checkpoint (normally up to 9
  ticks; the fallback checkpoint bounds an unmarked mutation at 50 ticks).
  Mutations that cannot afford to be lost must be followed by
  memoryManager.requestImmediateSave(reason) in the same tick.
  memoryManager.requestSave() is only a checkpoint/dirty marker and
  does not bypass the normal 10-tick cadence.
- The save cadence roughly aligns with spawnManager's 10-tick spawn
  eligibility interval. SAVE_INTERVAL divides the spawn ticker
  (currently 10). spawnManager.run is CRITICAL and executes every tick,
  while its inner eligibility gates control when spawn planning occurs. Console-triggered
  spawn paths may execute on arbitrary ticks and should call
  memoryManager.requestImmediateSave(reason) after writing creep memory.
  If either cadence changes, verify divisibility or add an explicit save.
- Client Memory-UI edits are never read and get clobbered on the
  next save tick. Run memoryReload() in the console after such edits.
- Serialization is sampled every 500 ticks when the CPU bucket is healthy. The scheduler reserves its
  rolling average cost times the rolling 100-tick save-hit rate, refreshed
  every 10 ticks, plus a safety buffer. memoryManager clears RawMemory._parsed
  on clean ticks and same-tick immediate-save calls do not carry into a
  duplicate save next tick.
- Memory durability has two distinct levels:
  - memoryManager.requestSave() marks an ordinary mutation for the next
    scheduled checkpoint. It must never set RawMemory._parsed or otherwise
    force same-tick serialization.
  - memoryManager.requestImmediateSave('module.action') is reserved for a
    mutation made with an irreversible game action, transaction-deduplication
    update, FIFO ownership change, or accounting boundary where rollback could
    duplicate work or corrupt state. The reason is mandatory and must be a
    stable module.action label.
  Routine progress, phases, caches, telemetry, history, cleanup, migrations,
  retry timers, and derived data use checkpoints, never immediate saves. Put
  the immediate save at the transaction boundary and avoid redundant caller
  saves when a callee already protects the same action.
- No module except memoryManager.js may assign or delete RawMemory._parsed.
  After changing persistence behavior, verify that checkpoint requests do not
  schedule same-tick saves and inspect memoryManager.getSaveStats() over a
  representative runtime window. Treat an unexplained save-rate increase as a
  regression.
- Transient state belongs in memoryManager.heap, not Memory. Get it
  with require('memoryManager').heap. It persists across ticks on the
  heap, is never serialized, and is empty after every global reset.
  The resident list is intentionally not maintained here; grep
  memoryManager.heap assignments for current residents.
  Only put data here whose loss on reset is acceptable (telemetry,
  profiling windows, recomputable caches).

Principles to keep serialization lean:

- Store only what is read. Every key in Memory is serialized.
- Prune aggressively. If a creep dies, delete its memory entry.
  Delete stale room state, obsolete orders, etc.
- Know your readers. Before adding a new Memory field, grep the
  codebase for code that reads it. If nothing reads it, do not add it.
- No full Memory schema is documented here. The Memory structure
  is distributed across the modules that own each area. To understand
  what a field is, read the module that writes and reads it.
- Derived state may be persisted when recomputation is expensive or
  historical continuity is required. Store source identifiers and
  invalidation metadata; prefer heap caches when reset loss is
  acceptable. Avoid serializing cheap per-tick derivations.
  Examples: spawnManager stores source metadata (refreshed every
  10k ticks), marketHistory retains 30-day transaction history and
  60-day market history in cold storage.

Storage buckets (see storageBuckets.js + flagVault.js):

- heap        — memoryManager.heap; recomputable, lost on global reset
- serialized  — Memory; active mutable state under SAVE_INTERVAL
- flag        — flagVault cold snapshots in E4N48; immutable after commit;
  logical keys in Memory.flagVault.index; FIFO-evict oldest unpinned blocks when free
  flag slots (10k − 100 conventional reserve) run out
- sign        — reserved for a future encrypted controller capsule

Inspect with storageOverview(), datasetList(), datasetInspect(id).
Application storage goes through require('memoryManager').storage. Register a
dataset policy, then use storage.get/set/ensure/update/remove. Policies describe
traits such as immutable/access/readFrequency or recomputable/resetLossOkay;
memoryManager selects heap, serialized, or cold storage. Explicit backend
selection is reserved for internal and legacy migration. Immediate serialized
mutations require a stable reason. Cold writes use storage.cold.publish/get/status and are
asynchronous and immutable. flagVault remains the physical codec and console
administration facade; application modules must not import it directly.

Direct Memory access is being migrated incrementally. New code must use the
storage API. Do not enable a strict direct-access guard until all existing
modules have migrated, because nested Memory mutations cannot be transparently
rerouted to an asynchronous cold backend.

Storage reservations and the VFS layer:

- Memory.storageReservationsV2 is the sole reservation root owned by
  storageVfs.js. Persisted V1 data is migrated at boot and deleted only after
  import succeeds and no legacy data-at-risk mismatches remain. V2-only locks
  do not block deletion.
  storageVfs.js owns resource locks, capacity locks, lock indexes, migration
  metadata, and orphan records.
- Writable resource paths are /rooms/<room>/storage/<resource> and
  /rooms/<room>/terminal/<resource>. Structure mounts use IDs:
  /rooms/<room>/factory/<factoryId>/<resource>,
  /rooms/<room>/lab/<labId>/<resource>,
  /rooms/<room>/container/<containerId>/<resource>, and
  /rooms/<room>/powerSpawn/<powerSpawnId>/<resource>. Nuker paths are rejected.
- Exported VFS TTLs are TTL_SHORT=500 (exported but currently unused),
  TTL_NORMAL=1000, TTL_QUEUED=2000, TTL_RESERVATION=100000, and
  STALE_RESERVATION_AGE=20000. Main's maintenance advances bounded lock and
  capacity cursors with maxChecks=50, separates expiry from stale-lock purges,
  and leaves capacity locking behavior unchanged.
- migrateLegacyReservations() aggregates duplicate V1 records by node and
  program, records malformed records as orphans, and removes V1 only after
  all valid locks are represented in V2. Reappearing V1 data is parity-checked
  again instead of being deleted solely because importedLegacy is set.

Permanent room terrain capsules:

- getRoomState.permanentFacts -- heap-backed at heap.roomState.permanentFacts,
  owned by permanentRoomFacts.js. Each owned-room entry contains only immutable
  controller/source/mineral positions and a terrain-only 3x3 sector travel
  matrix. It intentionally excludes roads, structures, storage, spawns, and
  timestamps. getRoomState exposes it as roomState.permanentFacts.
- permanentRoomFacts.js encodes the current capsule version into a checksummed
  controller sign: CtrlAltDefeat! | CAD1:<payload><checksum>. Missing, obsolete,
  or foreign signs in owned rooms may be replaced automatically by roleSignbot.
  Foreign signs are never trusted as navigation input. A global reset restores
  from a valid owner sign; live terrain recomputation remains the fallback.

9. Architecture and boot order

- main.js is the single entry point per tick. It requires() other
  modules at boot (first require loads, subsequent requires return
  cached exports). Some requires are purely for side-effect global
  registration.
- main.js owns the scheduler, creep death handler, role dispatch, CPU HUD,
  and tick orchestration. Keeping it minimal is a design goal; offload
  substantial new subsystems to their own modules.
- The profiler (screeps-profiler) wraps the main loop.
- The CPU scheduler decides which sections run based on bucket level
  and SECTION_TIER priority.
- Tick execution order (simplified): memoryManager.run at loop entry,
  budget/economics, room state init, defense, towers, links, VFS legacy
  migration, terminals, scanner, labs, spawning, creeps, bounded VFS
  maintenance, scheduler/status. End-of-tick code samples
  serialization cost; save eligibility is decided by memoryManager.run at
  loop entry.
  At boot memoryManager hydrates the V2 root; main's measured
  storageVfs.migration migrates legacy reservations before terminal work, and
  its post-runCreeps storageVfs.maintenance cleans VFS locks.

Data access hierarchy

When you need to access game world data, follow this order:

1. getRoomState (getRoomState.js) -- the primary cached room-state
   module. Call getRoomState.get(roomName) or getRoomState.all().
   Ownership source of truth: for claimed/owned-room decisions, use
   getRoomState.isOwned(roomName), getRoomState.owned(), or
   getRoomState.ownedNames(). Do not infer ownership from
   getRoomState.get(roomName), getRoomState.has(roomName),
   getRoomState.all(), Memory room-keyed data, or visibility in Game.rooms.
   getRoomState caches owned rooms plus visible rooms where our creeps/power
   creeps are present, so an unclaimed room can still have room state
   without being owned.
   Returns an object with these pre-computed fields:
   - controller, storage, terminal (direct room properties)
   - myCreeps, myPowerCreeps (built from global creeps index each tick)
   - hostiles (room.find(FIND_HOSTILE_CREEPS) every tick)
   - dropped (TTL 5), tombstones (TTL 10), ruins (TTL 50)
   - sources (TTL 500), minerals (TTL 500), constructionSites (TTL 25)
   - structuresByType (TTL 25)
   Never mutate the returned arrays. Never cache the result across ticks.

2. xxxQuery.js modules -- marketQuery.js for market data,
   memoryQuery.js for Memory introspection.

3. Raw Game API -- When getRoomState does not expose a needed category,
   when current-tick membership matters, when filtered engine queries
   are cheaper, or when operating in non-cached rooms.
   Document why in the module if used for owned-room code.

room.find() convention: use getRoomState by default for claimed rooms.
Direct room.find() is allowed when freshness, unsupported categories,
or performance dictate otherwise.

Spawning

All spawning flows through spawnManager.js. The entry point is:

    spawnManager.run(perRoomRoleCounts)

New spawn capability should be added as a manageXxxSpawns function in
spawnManager.js, then exported from its module.exports block.

Never call Game.spawns[name].spawnCreep() from outside spawnManager.js.

Major subsystems

- scanner.js is the central intel and observer subsystem. It owns
  room intel, player scans, nuke analysis, wide scans, war estimates,
  the room registry, and observer scheduling. Other modules should
  request observer work through require('scanner').observe.request()
  instead of directly controlling observers.
  Adaptive consumers that require live room data must request with
  { untilConsumed: true, holdTicks: N }, persist their domain result, then call
  scanner.observe.consume(roomName, source). The hold must cover the section's
  hard deferral and remains bounded; do not assume the first visibility tick is
  also a consumer invocation.

- storageManager.js is a compatibility facade over V2 resource locks. Terminal,
  factory, lab, market, and transfer code should reserve resources here before
  moving them. storageVfs.js owns resource and capacity locks in
  Memory.storageReservationsV2; direct VFS callers use its concrete paths and
  bounded maintenance. Console helpers include vfsStatus(), vfsLs(path),
  vfsParityReport(room), and vfsMigrateLegacy(force).

- terminalManager.js owns cross-room terminal logistics and terminal
  busy-state decisions. Prefer its transfer commands/helpers instead
  of ad hoc terminal.send() calls.

- labManager.js owns reaction orders and lab layout. boostManager.js
  owns boost orders and role boost state. Do not mix reaction, boost,
  and market-lab state unless the owning module exposes an API for it.
  Note that lab reactions (runReaction, reverseReaction, and pipeline stages)
  consume only minerals and do not require or draw energy; energy is only
  loaded into labs for creep boosting (owned by boostManager.js).
  labManager.js installs labsPipelineDiagnose, labsPipelineDiagnoseJSON,
  labsPipelineSelfTest, labsDiagnoseRoom, and labsDiagnoseBots; the nested
  labCommodityRouter also exposes labCommodityStatus().

- factoryManager.js owns commodity production orders. Factory work
  should go through orderFactory/cancelFactoryOrder style commands, not
  one-off factory.produce() calls from unrelated modules.
  Successful production is checkpointed at the normal Memory cadence. During
  processing, factoryManager retains output in the factory as a physical reset
  witness, reconciles rolled-back batch accounting from a persisted per-cycle
  baseline, and does not allow supplier unloading until that accounting reaches
  a save tick. Do not bypass the ready/loadingPending/unloadingPending phases.

- repairManager.js owns unified repair planning, repair spawn
  requests, and nuke repair planning. Legacy repair roles still exist,
  but new repair orchestration should integrate with repairManager.
  Rampart targets/caps are configurable consts at the top of
  repairManager.js, exported via repairManager.constants (used by
  towerManager, roleRepairer) -- never redefine them.

- compliance.js registers global.compliance.help(), maxEnergyCreeps(),
  checkMaxEnergyCreeps(), retireUndersizedHarvesters(), roomLayout(), and
  fixRampartCompliance(). The main loop also calls
  compliance.retireUndersizedHarvesters() behind a 5000-tick guard.

- roomSuspender.js is a CPU-shedding system for low-risk rooms. It
  can suspend room-local work while keeping critical systems such as
  defense, scans, and market work alive. Respect its state before adding
  new per-room recurring work.

- taskScheduler.js persists console commands in Memory and re-runs
  them every N ticks. It intentionally evals scheduled command strings.
  Globals: schedule, unschedule, listScheduled, runScheduled,
  updateScheduled. Key Memory owner: Memory.taskScheduler.

- powerManager.js owns account-wide GPL targets, serialized 1000-power
  market tranches, and the synchronized 10-tick PowerSpawn cadence.
  roleSupplier.js fills active PowerSpawns with power and energy;
  rolePowerBot.js only retires legacy powerbots. roleOperator.js owns
  power-creep/operator setup, using Memory.operators and related
  source-regen Memory keys.

- market*.js modules own market automation. Important convention:
  Game.market.createOrder() returns OK but does not synchronously expose
  the new order id; managed market modules track pending/order state in
  Memory and reconcile on later ticks.

- marketPricing.js is the single market-pricing authority. It provides
   external-only, dust-filtered books, robust bounded-depth references,
   executable quotes, and getPriceProfile(resource). The profile separates
   immediate sellPrice/buyPrice, passive postedSellPrice/postedBuyPrice, and
   marketPrice. It also reports active/buyers-only/sellers-only/empty state,
   side liquidity quality, crossed-book anomalies, and confidence.
   Dead lab/factory product markets use getTheoreticalPrice() from forward
   recipe dependencies, processing-level markup, and the market fee; historical
   averages are diagnostic and may only stabilize a validated live market. Prefer getPriceProfile,
   getTheoreticalPrice, getBook, getAvg48h, getAvg7d, executableBuyQuote,
   executableSellQuote, inputCeilings, chooseBuyMethod, and getHistDays over
   hand-rolling averages or order-book scans.
    Its book is external-only, dust-filtered (remaining >= 1000), and rebuilt
    when util.marketSnapshot() refreshes (default 30-tick TTL). Derived books
    and profiles are cached per shared snapshot. The console helper
    priceDiagnostics(5) samples five random commodity profiles and prints the
    active thresholds, depth, spread, history, and theoretical fallback data.
    marketPricing also registers prices(resource?, sortBy?), priceProfile(resource),
    priceDiagnostics(count?) and its marketPriceDiagnostics(count?) alias, plus
    conversionQuote(resource, amount, roomName). marketQuery.js registers
    marketPrice(resource, mode) for average, buy-order, or sell-order queries;
    marketConditions.js registers marketVolume(days?, includeAll?).
- marketAnalysis.js, marketReport.js, autoTrader.js, and marketSpeculator.js
  consume marketPricing; do not add local price formulas or historical fallbacks.
- marketArbitrage.js's capByEnergy uses a power-creep-aware cost model. Its
  phases are scheduled separately: reconcilePending is always-run,
  serviceActive is HIGH-tier inventory resolution, and scan is LOW-tier
  discovery with a two-tick base interval. The central scheduler owns scan
  cadence; do not add a second CPU-average interval inside marketArbitrage.
- Realized averages from own transaction logs (marketReport.js) are
  bookkeeping, not market pricing, and are fine.
- getAvg48h returns null with no history. It is a diagnostic/history metric,
  not a universal fallback for dead markets; use the canonical profile and its
  theoretical value instead.

Market Economics Contract

The approved production-trading objective is expected end-to-end economic net
credits per tick, not margin percentage. Migration is in progress.

- marketAnalysis.scoreProduction() owns expected scoring; autoTrader
  still supplies price/recipe inputs and consumes the score.
- Admission requires strictly positive expected net profit after modeled
  material costs, fees, reprice allowance, and terminal-energy allowance.
- The scheduling score is expectedNetProfit / expectedElapsedTicks.
- Margin is diagnostic only.
- Lab reverse and forward share sell-exposure ranking; factory jobs are a separate pool.
- AutoTrader sell exposure caps are commodity-specific: 25% of median daily
  market volume over up to 14 completed history days, clamped to 10-100000.
  Fewer than four completed days uses the 10-unit floor. Listed sell orders,
  active lab/factory output, and newly selected jobs all count toward the cap;
  autoTrader('limits') shows the calculation for each commodity.
- Stable jobId values are minted by marketEconomics.js and stored on
  launched ops. Memory.marketEconomics is the canonical bounded ledger
  (observation-only until realized accounting is complete).
- marketEconomics keeps the newest 20 closed jobs hot. Older compact terminal
  jobs with no sell-lot ownership or delayed market/production references are
  published under me.job.v1:<jobId>,
  physically confirmed, read back and compared, then removed from serialized
  storage with an immediate save. Never clear the source before owner-level
  verification. Archived lookup is read-only and FIFO vault eviction can make
  sufficiently old records unavailable.
- processedTransactions retains only transaction IDs still visible in the
  bounded Game.market incoming/outgoing lists. Missed sell-fill reconciliation
  consumes lot ownership FIFO from the head and records unpriced reconciliation
  evidence on the owning job; never trim the newest tail first.
- phase(jobId, 'selling') sets the economics status to selling. Selling jobs
  are split after a verified cold publication: immutable production detail is
  pinned under me.job.base.v1:<jobId>, while a compact serialized settlement
  delta retains operation links, sell-lot attribution, and subsequent fills.
  Once references clear, the composed terminal summary is verified under
  me.job.v1:<jobId> and the temporary base is removed. AutoTrader sell-exposure reservations use projected
  current-plus-new amounts and reserve reverse outputs atomically.
- Realized completion requires actual sale fills, not merely sell-order posts.
- Shared sell orders use FIFO lots; passivated post-cancel buy fills detach as
  unowned inventory acquisition.
- dailyFinance.js remains account-level reconciliation.
- Console: marketEconomicsStatus(), marketEconomicsJob(jobId),
  marketEconomicsArchiveStatus(), marketEconomicsArchivePurgePreview(),
  marketEconomicsArchiveRetry(jobId), and marketEconomicsRetentionStatus().

10. Do and Don't -- hard rules

These are non-negotiable. The detailed contracts above are authoritative;
the following cross-cutting checks are the short review gate.

DO

- Register public console globals in the owning module, not in main.js.
  Internal global caches use a __ prefix and are documented in the owning module.
- Add every creep role to statusReport.js per-room display (total counts are
  automatic). Current dispatch and status details are explicit: wallRepair and
  rampartBot have priority 20 and dispatch to roleRepairer; defenseRepair has
  priority 4 and dispatches to roleRepairer; quad has priority 1 and dispatches
  to roleSquad; terminalBot has priority 5 and dispatches to
  terminalManager.runTerminalBot. wallRepair and rampartBot remain absent from
  per-room status rows, so total rendering falls back to their raw names.
  defenseRepair, quad, and terminalBot remain in the per-room rows and use
  their existing icons: 🔩, 🤖, and 📡.
- Check creep.memory.role before doing role-specific lookups.
- Use iff.isHostileCreep() and iff.isFriendlyUsername() for hostility decisions.
  Never copy the whitelist. Add new friendly identities in iff.js only.
- Delete creep memory when a creep dies.

DON'T

- Do not add global.X = ... lines to main.js. Put them in the owning module.
- Do not add Memory fields speculatively. Grep for readers first.
- Do not leave this directory. All bot code is in the same directory as this file.
- Do not require() this file from any other module.
- Do not introduce ESM syntax (import, export) -- CommonJS only.
- Do not import flagVault from application modules; use
  require('memoryManager').storage.cold. flagVault is reserved for its physical
  backend and console administration.
*/
