// LLM: Read docs/codex.js before reviewing or changing this file.
// docs/codex.js
// Pure documentation for LLM-based code review and generation.
// No runtime purpose; the entire body is a block comment.
// Long-form rationale lives in docs/codex-full.js (not deployed).
// RUNTIME AUTHORITY: The root-level *.js files directly under default/ are the
// canonical modules loaded by Screeps. The src/ directory is temporary scratch
// storage only, not a parallel source tree or deployment input. Apply runtime
// changes to root modules and import root modules in tests.
// DEPLOY LIMIT: root *.js payload is capped at 5 MB of JSON.stringify(modules).
// Stay under it -- check with a JSON.stringify size measurement before adding
// large modules or verbose comments; trim before adding if close to the cap.

/*
Codex - Screeps Bot

1. Identity and environment

Screeps bot on Shard 3: mining, trading, defense, room management, labs,
factory, power. Self-contained CommonJS modules, one directory.

- CPU limit 20/tick. Bucket tiers CRITICAL(<1000) / LOW(1000-2999) /
  NORMAL(3000-7999) / FLUSH(8000+). Budgets subtract amortized serialization
  plus a tier buffer (7 / 3 / 1 / 0.1 CPU, not cumulative).
- Node v24; ES2024+ available. CommonJS only -- no import/export, no npm
  packages. Only the Screeps sandbox globals exist at runtime.
- No local full-game emulator. Local validation is `node --check file.js` and
  the dependency-free mocks in test/, run as
  `NODE_PATH=. node test/<name>_harness.js`. These do not replace in-game
  testing. In-game: deploy, check LOW and CRITICAL bucket behavior,
  profileFor(ticks?, filter?), cpuJSON(), flagVault.test(1024).
- Stay in this directory. Do not navigate to parent dirs, home, or Steam
  config unless explicitly asked.
- Deployment payload is capped at 5 MB of JSON.stringify(modules) --
  root *.js only; subdirectories such as test/ and docs/ are not uploaded.

2. Module taxonomy

- roleXxx.js      creep role; exports run(creep), optionally spawn()
- xxxManager.js   per-tick orchestrator; usually exports run()
- xxxQuery.js     read-only access; registers console globals
- xxxProfiler.js  CPU profiling utilities
- xxxPolicy.js    shared predicates and derived limits
- xxxPipeline.js  pure planning/validation helpers
- xxxRouter.js    bounded nested worker for queueing/routing
- xxxSlots.js     operation-capacity accounting and refusal helpers
- xxxLedger.js    small accounting state shared by callers
- xxx.js          standalone single-purpose module
- docs/codex.js   this file

Slots/ledger/policy/pipeline/router/compliance are libraries or nested
workers, not scheduler sections; their cost inherits the calling section.

New work: creep role -> roleXxx.js; tick orchestrator -> xxxManager.js;
console tool -> xxxQuery.js with the global registered in that file.

3. Code style

- Header: line 1 `// LLM: Read docs/codex.js before reviewing or changing this
   file.`, line 2 the filename, then a short purpose description.
- module.exports = { ... }. Side-effect-only console modules may omit it.
- 2-space indent, no tabs. const by default, let when reassigned; var is
  legacy. Named function declarations at top level, arrows for short helpers.
- Modules that register console commands include `// Console globals:` and concise
  `// Example:` line comments near the top referencing docs/codex.js so that the
  commands and usage remain visible in generated root modules. Role controllers
  include the role entrypoint and one dispatch example. Keep examples accurate and short.
- Generated root modules preserve header comments referencing docs/codex.js and
  usage/examples; all other comments are stripped by the deployment build to protect
  the 5 MB payload limit.
- Comment invariants, state transitions, performance decisions, and engine
  behavior. Not the obvious.
- Many functions return Screeps result codes directly. isSuccess(result) in
  roomBalance.js checks [OK, 0, true, 'OK', 'queued'].

4. Logging

Console output costs CPU. Declare a per-module LOG_INTERVAL constant, gate on
`Game.time % LOG_INTERVAL === 0`, usually via a module-level log() helper.
Existing cadences: 5 (roleBuilder), 25 (roomCPUProfiler), 250 (scanner).
Do not reuse another module's interval unless the cadence is shared on purpose.

5. Scheduler

main.js has two wrappers:

- profileSection(name, fn): throttled by SECTION_TIERS priority. CRITICAL runs
  every tick; HIGH/NORMAL/LOW stretch to 2/3/5 ticks under pressure and may
  take bounded cost-based minimum intervals of 2/5/10 ticks. FLUSH bypasses the
  cost interval but keeps explicit base cadences, and its late pass may overrun
  budget by up to 50% of the CPU limit when bucket allows. Predicted overruns
  accrue retry debt; the oldest hard-aged debt may run once per tick but never
  consumes CPU reserved for CRITICAL sections that have not run. Hard aging is
  not a delivery guarantee. Cost/retry state is heap-only in
  heap.cpuSectionStats. Sections in SECTION_CPU_SLICES receive a CPU allowance
  as the callback argument.
- measureSection(name, fn): measured, never throttled or tiered. For bounded
  ALWAYS_RUN work only, with a comment saying why deferral is unsafe.

screeps-profiler is always initialized so profileFor() works immediately;
profile a new function with profiler.registerFN(). Registered functions keep a
small wrapper cost even when no capture is running. scanner deliberately
bypasses both wrappers and reports its own phase costs.

Every profileSection name must exactly match a SECTION_TIERS entry. A missing
entry defaults to NORMAL but produces an undefined name hash and can stall the
section under pressure. Only the name at the call site is a section; helpers
called inside it are not.

Classify a module before adding it to main.js. Under sustained load HIGH,
NORMAL and LOW work can be deferred up to 10, 25 and 50 ticks.

- CRITICAL   must act every tick and stay bounded (towers, spawning, defense,
             core creep dispatch). Tower-filler spawning is nested inside
             spawnManager.run via manageTowerFillerSpawns (10-tick internal
             gate); there is no separate tower-filler section.
- ADAPTIVE   safe after an arbitrary gap; resumes from durable state.
- SLICED     adaptive and expensive; honors the CPU allowance.
- ALWAYS_RUN bounded and undeferrable; uses measureSection.

Adaptive contract:
- Never use `Game.time % N` as a correctness gate -- a deferred call can miss
  the tick forever. Persist lastRun/nextRun and run on the first invocation at
  or after the due tick.
- Treat every invocation as overdue. Transactions, spawn requests,
  construction sites, terminal sends and market actions must be idempotent or
  guarded by durable pending state written before the action.
- Never require another module, an observer result, or a cooldown to land on
  the very next tick. Re-check current state on resume.
- Keep direct defense/economy/creep intents in CRITICAL paths.
- Bound every invocation; full scans need a durable cursor or a small
  documented maximum.

Sliced contract:
- An omitted cpuAllowance means no slice was assigned and must not change
  behavior.
- Derive a deadline from Game.cpu.getUsed() + cpuAllowance and check it only
  between complete, retry-safe units.
- Persist the cursor before returning. Never yield mid-action or before
  recording deduplication state.

Anti-patterns: modulo gates in adaptive modules; unbounded world scans without
resumable progress; assuming a manager runs just before its creep role;
deferring defense or core-energy intents.

6. Memory and storage

memoryManager.run() is the first call each tick. Memory is heap-backed: the
parsed object is reused across ticks (no per-tick JSON.parse) and serialized
only at dirty checkpoints (SAVE_INTERVAL 10 ticks) or on immediate saves.

- A global reset rolls Memory back to the last checkpoint -- up to 9 ticks, or
  50 for an unmarked mutation.
- requestSave() only marks the checkpoint dirty. It must never set
  RawMemory._parsed or force same-tick serialization.
- requestImmediateSave('module.action') is for mutations paired with an
  irreversible game action, transaction dedup, FIFO ownership change, or an
  accounting boundary. The reason is mandatory and must be a stable
  module.action label. Put it at the transaction boundary; do not double-save
  when a callee already protects the action.
- Progress, phases, caches, telemetry, history, cleanup, migrations, retry
  timers and derived data use checkpoints, never immediate saves.
- SAVE_INTERVAL divides spawnManager's 10-tick eligibility ticker. Console
  spawn paths run on arbitrary ticks and must requestImmediateSave after
  writing creep memory. If either cadence changes, re-verify divisibility.
- Only memoryManager.js may touch RawMemory._parsed. After changing
  persistence, inspect memoryManager.getSaveStats(); an unexplained save-rate
  increase is a regression.
- Client Memory-UI edits are clobbered on the next save; run memoryReload().
- Transient state goes in memoryManager.heap, not Memory: survives ticks,
  never serialized, empty after a global reset. Only put loss-tolerant data
  there.

Keep serialization lean: store only what is read; prune dead creeps, stale
room state and obsolete orders; grep for readers before adding a field; no
Memory schema is centralized -- the owning module defines it. Persist derived
state only when recomputation is expensive or history matters.

Storage buckets (storageBuckets.js + flagVault.js):
- heap        recomputable, lost on reset
- serialized  Memory, under SAVE_INTERVAL
- flag        flagVault cold snapshots in E4N48, immutable after commit,
              index in Memory.flagVault.index, FIFO eviction of oldest
              unpinned blocks; a queued write stages at most 20 flags per
              tick because createFlag is a 0.2 CPU intent
- sign        reserved

Go through require('memoryManager').storage: register a dataset policy, then
get/set/ensure/update/remove. Policies describe traits (immutable, access,
readFrequency, recomputable, resetLossOkay) and memoryManager picks the
backend. Cold writes via storage.cold.publish/get/status are asynchronous and
immutable. Application modules must never require flagVault directly. Inspect
with storageOverview(), datasetList(), datasetInspect(id).

New code uses the storage API. Direct Memory access is migrating
incrementally; do not add a strict direct-access guard until every module has
migrated, because nested Memory mutations cannot be rerouted to an async cold
backend.

VFS reservations:
- Memory.storageReservationsV2 is the sole reservation root owned by
  storageVfs.js. Persisted V1 data is migrated at boot and deleted only after
  parity; a reappearing V1 root is checked again rather than blindly deleted.
- Paths: /rooms/<room>/storage/<resource>, /rooms/<room>/terminal/<resource>,
  and ID-mounted /rooms/<room>/{factory|lab|container|powerSpawn}/<id>/<resource>.
  Nuker paths are rejected.
- TTLs: TTL_SHORT=500 (unused), TTL_NORMAL=1000, TTL_QUEUED=2000,
  TTL_RESERVATION=100000, STALE_RESERVATION_AGE=20000. Maintenance is bounded
  at maxChecks=50 per resource/capacity pass, advances cursors, and reports
  expired versus stale lock purges separately; capacity locks are unchanged.
- Console: vfsStatus(), vfsLs(path), vfsParityReport(room),
  vfsMigrateLegacy(force).

permanentRoomFacts.js owns heap.roomState.permanentFacts, exposed as
roomState.permanentFacts: immutable controller/source/mineral positions and a
terrain-only 3x3 sector matrix, nothing else. It encodes the capsule into a
checksummed controller sign (CtrlAltDefeat! | CAD1:<payload><checksum>) that
roleSignbot may replace when missing or obsolete. Foreign signs are never
trusted as navigation input.

7. Data access

Order of preference:
1. getRoomState.get(roomName) / .all() -- cached per tick. Fields: controller,
   storage, terminal, myCreeps, myPowerCreeps, hostiles, dropped (TTL 5),
   tombstones (10), ruins (50), constructionSites (25), structuresByType (25),
   sources (500), minerals (500). Never mutate the returned arrays, never
   cache across ticks.
2. xxxQuery.js modules.
3. Raw Game API, when the category is unsupported, current-tick membership
   matters, a filtered engine query is cheaper, or the room is uncached.
   Document why in owned-room code.

Ownership source of truth is getRoomState.isOwned(), .owned(), .ownedNames().
Never infer ownership from .get(), .has(), .all(), Memory room keys or
Game.rooms visibility -- state is cached for visible unowned rooms too.

8. Subsystem ownership

Respect the owner; do not reach around it.

- main.js        entry point, scheduler, creep death handling, role dispatch
                 (boostManager.handleCreep runs first and can pre-empt it),
                 CPU HUD. Keep it minimal; new subsystems get their own module.
                 Boot order: memoryManager.run, budget/economics, room state,
                 defense, towers, links, VFS migration, terminals, scanner,
                 labs, spawning, creeps, VFS maintenance, scheduler/status.
- spawnManager   all spawning. New capability is a manageXxxSpawns function.
                 Never call spawnCreep() from outside this module.
- scanner        intel, player scans, nuke analysis, room registry, observers.
                 Request visibility via scanner.observe.request(); adaptive
                 consumers pass { untilConsumed: true, holdTicks: N }, persist
                 their result, then scanner.observe.consume(room, source). The
                 hold must cover the section's hard deferral.
- storageManager V1 reservations; reserve before moving resources.
- terminalManager cross-room logistics and terminal busy state; prefer its
                 helpers over ad hoc terminal.send().
- labManager     reaction orders and lab layout. boostManager owns boosts. Do
                 not mix reaction, boost and market-lab state. Note: lab
                 reactions (runReaction, reverseReaction, and pipeline orders)
                 do not require or consume energy; only creep boosting uses
                 energy.
- boostManager   every boost, for every role. Orders name compounds (tier
                 number, compound list, or {compound: parts}); part counts are
                 resolved from a pinned order body, else a live creep of that
                 role, else spawnManager.getCreepBody at energy capacity. Role
                 files contain no boost code: main.js calls
                 boostManager.handleCreep(creep) before role dispatch, and a
                 true return means the creep spent the tick moving to a lab,
                 boosting or unboosting. Spawn paths that do not inject a
                 manifest still work -- handleCreep attaches one during the
                 creep's first ticks. Spawn gating (shouldGateSpawn) is off for
                 roles the room cannot stall on; military and critical roles
                 also stop waiting for a lab after maxBoostWait ticks.
- factoryManager commodity production. Use orderFactory/cancelFactoryOrder,
                 not bare factory.produce(). Output is retained in the factory
                 as a reset witness and batch accounting reconciles from a
                 persisted baseline; do not bypass the
                 ready/loadingPending/unloadingPending phases.
- repairManager  repair planning, repair spawns, nuke repair. Rampart
                 targets/caps are exported via repairManager.constants and used
                 by towerManager and roleRepairer -- never redefine them.
- powerManager   GPL targets, 1000-power market tranches, 10-tick PowerSpawn
                 cadence. roleSupplier fills PowerSpawns; roleOperator owns
                 power creeps; rolePowerBot only retires legacy powerbots.
- roomSuspender  CPU shedding for low-risk rooms; check its state before
                 adding per-room recurring work.
- taskScheduler  persists and re-runs console commands (it evals them).
                 Globals: schedule, unschedule, listScheduled, runScheduled,
                 updateScheduled. Owns Memory.taskScheduler.
- compliance     console reports and fixes for spawn-model, room-layout and
                 rampart compliance: global.compliance.help(),
                 maxEnergyCreeps(), checkMaxEnergyCreeps(),
                 retireUndersizedHarvesters(), roomLayout(),
                 fixRampartCompliance(). main calls
                 retireUndersizedHarvesters() behind a 5000-tick guard.
- iff            hostility decisions; add friendly identities here only.

9. Market

- marketPricing is the single pricing authority. Use getPriceProfile,
  getTheoreticalPrice, getBook, getAvg48h, getAvg7d, executableBuyQuote,
  executableSellQuote, inputCeilings, chooseBuyMethod, getHistDays. Never
  hand-roll averages or order-book scans. The book is external-only,
  dust-filtered (remaining >= 1000) and rebuilt with util.marketSnapshot()
  (30-tick TTL). Dead lab/factory markets fall back to getTheoreticalPrice from
  forward recipes, processing markup and fee; historical averages are
  diagnostic only, and getAvg48h returns null with no history.
- Consumers (marketAnalysis, marketReport, autoTrader, marketSpeculator) must
  not add local price formulas or fallbacks. Realized averages from own
  transaction logs (marketReport) are bookkeeping, not pricing.
- Game.market.createOrder() returns OK without exposing the new order id;
  track pending/order state in Memory and reconcile on later ticks.
- Buy-side spend ceiling: marketPricing.buyPriceCeiling(res) is the hard cap on
  any price we PAY. It is the minimum of three independent references, each
  built from corroborated depth rather than the top order: 10x the volume-
  weighted median daily price over 14 days of getHistory, and 5x the median ask
  across the cheapest DEPTH_VOLUME. Depth only counts with >= 3 price levels
  from >= 3 distinct rooms and >= 2000 units, and the walk outward from the
  touch STOPS at the first gap wider than CEILING_LEVEL_GAP, so neither one
  player's wall nor the far half of a bimodal book can capture the median. The
  bid side is reported for disagreement but never caps: sampled books show real
  bid sides 2x-100x under the traded price. The 14-day median is also a FLOOR on
  the ceiling -- we can always pay what the shard has been paying, so a
  depressed source cannot silently block buying. Above the ceiling the book is not believed at all: passiveBuyPrice and
  getStatusEnergyPrice fall back to the binding source's reference (fair
  value), never to the ceiling, since paying the ceiling is still paying 10x on
  purpose. marketBuy caps caller-supplied prices at the ceiling, folds it into
  both reprice paths, and refuses automated buys outright when no source
  qualifies (an explicit caller price overrides that refusal, still capped).
  marketSpendGuard wraps Game.market.deal and createOrder once per tick as the
  last line, so a module that never learned the ceiling cannot overpay; blocks
  are logged to Memory.marketGuard (marketGuardStatus(), buyCeiling(res)). Never post a BUY from bestAsk/bestBid alone.
- Valuation and posting are different questions and must not share a number.
  getStatusEnergyPrice() is REPLACEMENT COST -- the cheaper of the two routes
  that can actually add a unit. passiveBuyPrice() is what to POST, and stays on
  the bid leg: resting under the competing bids to match a direct price we
  could simply go and take wins nothing, because the direct route is captured
  by acting, not by bidding low.
- acquisitionQuote(resource[, amount]) -> {price, route, bid, direct} is the
  general form; energyAcquisitionQuote() is the energy default behind
  getStatusEnergyPrice(). The
  BID leg is the posted bid (freight-free; whoever fills it deals and pays the
  transfer), clamped to the corroborated ceiling. The DIRECT leg is
  deliveredBuyQuote() across owned rooms, cheapest first. Note the structural
  consequence: in an uncrossed book the posted bid always sits under the best
  ask, so DIRECT can only win when the book is CROSSED -- which is the normal
  state of shard3 energy, where distance segments the market and far bidders
  bid over near asks. statusReport's "⚡ Mkt" prints the winning route.
- Acquisition has two routes with different economics, and autoEnergyBuyer
  compares them per room for BOTH energy and batteries. A standing BUY order
  costs no freight: whoever fills it calls deal() and pays the terminal
  transfer. Taking a live ask makes US the dealer and we pay it. Freight is
  always charged in energy, but it LANDS differently and deliveredBuyQuote()
  branches on this: buying energy it comes out of the shipment, so
  delivered = price * take / (take - transferCost) and less arrives than we
  bought; buying anything else the full quantity arrives and the energy is a
  separate credit cost, so delivered = price + transferCost * energyPrice /
  take. Never compare sticker prices. The direct route is measured against the
  BID LEG, never against the blended acquisition price -- that already contains
  the direct route, so comparing it with itself always ties.
  Yield is exp(-distance/30) and size-independent; MIN_DELIVERY_YIELD stops the
  route at roughly 20 rooms, because past that a shipment arrives as a rounding
  error while the freight is real. Direct takes go through marketBatchBuy,
  which already checks terminal capacity, terminal energy and credits, and open
  jobs count toward the room's on-order total so the passive order is sized
  against what is genuinely still missing. Urgent tiers (forceEnergy) accept a
  premium over the standing bid for immediacy; the price-optimal tier does not.
- marketArbitrage phases are scheduled separately (reconcilePending always-run,
  serviceActive HIGH, scan LOW with a 2-tick base). The central scheduler owns
  scan cadence; do not add a second interval inside the module.

Economics contract -- the objective is expected net credits per tick, not
margin percentage:
- marketAnalysis.scoreProduction() owns scoring; score is
  expectedNetProfit / expectedElapsedTicks. Margin is diagnostic.
- Admission requires strictly positive expected net profit after materials,
  fees, reprice allowance and terminal energy.
- Sell exposure caps are per-commodity: 25% of median daily volume over up to
  14 completed history days, clamped 10-100000, with the 10-unit floor below
  four days. Listed orders, active output and new jobs all count.
  autoTrader('limits') shows the calculation.
- marketEconomics.js mints jobIds and owns Memory.marketEconomics. The newest
  20 closed jobs stay hot; older ones publish to me.job.v1:<jobId>, are read
  back and compared, then removed with an immediate save. Never clear a source
  before owner-level verification. Archived lookup is read-only and FIFO
  eviction can drop old records.
- processedTransactions retains only IDs still visible in Game.market's
  bounded lists. Missed sell fills consume lot ownership FIFO from the head --
  never trim the newest tail first.
- Shared sell orders use FIFO lots. Realized completion requires actual fills,
  not sell-order posts. dailyFinance.js stays account-level reconciliation.
- Console: marketEconomicsStatus(), marketEconomicsJob(jobId),
  marketEconomicsArchiveStatus(), marketEconomicsArchivePurgePreview(),
  marketEconomicsArchiveRetry(jobId), marketEconomicsRetentionStatus().

Console globals are registered by their owning module, not listed here --
grep `global.` to enumerate them.

10. Hard rules

DO
- Register console globals in the owning module. Internal global caches use a
  __ prefix and are documented there.
- Add every creep role to statusReport.js per-room display. Existing dispatch:
  wallRepair and rampartBot (priority 20) and defenseRepair (4) -> roleRepairer;
  quad (1) -> roleSquad; terminalBot (5) -> terminalManager.runTerminalBot.
  wallRepair and rampartBot are absent from per-room rows; defenseRepair, quad
  and terminalBot use icons 🔩, 🤖, 📡.
- Check creep.memory.role before role-specific lookups.
- Use iff.isHostileCreep() and iff.isFriendlyUsername(); never copy the
  whitelist.
- Delete creep memory when a creep dies.

DON'T
- No global.X = ... in main.js.
- No speculative Memory fields; grep for readers first.
- Do not leave this directory.
- Do not require() this file; it is documentation only.
- No ESM syntax.
- Do not import flagVault from application modules; use
  require('memoryManager').storage.cold.
*/
