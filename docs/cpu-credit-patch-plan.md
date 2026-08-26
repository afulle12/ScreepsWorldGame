# Patch Plan — CPU Budget Calibration, Save Discipline, Credit Loop, Spawn Gate

Four independent patches found from the 100-tick profile at tick 82492967 and
the accompanying console log. Each is separately landable and separately
revertable. Ordered by value-to-effort.

Baseline at time of capture: `CPU Min: 15 Avg: 19 Max: 57 Mem: 0.000 (26.0% hit)
| Bucket: 3086 (31%)`, limit 20, bucket drifting down (3168 -> 3087 -> 2990 ->
3028 -> 3000 -> 2980), tier flapping NORMAL/LOW.

## File overlap with the concurrent VFS migration

| Patch | Files | Overlap |
| --- | --- | --- |
| 1 | `memoryManager.js` | **Yes** — VFS work touches `hydrateStorageReservations` / `hydrateStorageReservationsV2` in the same file. Different functions; land in either order but do not edit concurrently. |
| 2 | `memoryManager.js` (diagnostic only), `marketPriceAdjustment.js`, `marketEconomics.js` | Partial — **do not touch `marketSell.js` or `autoTrader.js` in this patch**; they are VFS-migration files. Defer their call sites to a follow-up. |
| 3 | `marketBuy.js`, `marketRefine.js` | None |
| 4 | `spawnManager.js` | None |

---

## Patch 1 — Serialization reserve reads 0.000 and deadlocks the budget

**Priority: highest. One constant.**

### Symptom
Status line reports `Mem: 0.000 (26.0% hit)`. Arithmetically impossible —
`memoryProfile()` measures `JSON.stringify(Memory)` at 2.602 CPU, and saves fire
on 26% of ticks, so the true amortized cost is **~0.677 CPU/tick**.

### Root cause
`memoryManager.js` — `sampleSerializationCost()` first line:

```
if (Game.cpu.bucket < SERIALIZATION_SAMPLE_MIN_BUCKET) return;
```

`SERIALIZATION_SAMPLE_MIN_BUCKET = 5000` (memoryManager.js:10). Bucket sits at
~3000, so **the sampler has never run**. `heap.memorySerialization.samples` stays
empty, `recordSerializationCost` never sets `t.cpu`, and
`refreshAmortizedSerializationCost` falls back to `e.cpu || 0` = 0. Therefore
`amortizedCpu = 0 * 0.26 = 0.000`.

That value is consumed by `main.js:419` `updateTickBudgetForSave()`:

```
tickBudget = max(0, tickCpuLimit - amortizedCpu - tickSafetyBuffer)
```

**The scheduler reserves zero CPU for a save that actually costs 2.602.** On save
ticks it over-commits by the full amount — the mechanism behind `Max: 57`.

This is self-reinforcing: the bucket must exceed 5000 to calibrate, but the
miscalibration produces the overruns that keep it below 5000.

### Fix
Two changes, both in `memoryManager.js`:

1. Lower `SERIALIZATION_SAMPLE_MIN_BUCKET` from `5e3` to `2e3` so sampling can
   run at the colony's actual operating bucket.
2. Make the cold-start fallback non-zero in `refreshAmortizedSerializationCost`
   so the reserve is never 0 before the first sample lands. Replace the
   `e.cpu || 0` fallback with a conservative constant (suggest
   `SERIALIZATION_COLD_START_CPU = 1.0`) rather than 0.

Change 2 matters independently of change 1: after any global reset the heap is
empty and the reserve returns to 0 until the next sample, which is up to
`SERIALIZATION_SAMPLE_INTERVAL` (500) ticks away.

### Sampling cost check
`sampleSerializationCost` runs at most every 500 ticks and skips ticks where
`willSaveThisTick`, so it adds 2.602 / 500 = **0.005 CPU/tick**. Negligible.

### Verification
- Status line shows `Mem:` converging to ~0.6-0.7 rather than 0.000 within 500
  ticks.
- `Max` CPU falls from 57 toward the tick limit.
- Bucket trend flattens or rises.

### Risk
Low. Reserving budget that was previously unreserved *reduces* per-tick work
available to sections, so expect slightly more section deferrals — that is the
correct behaviour, not a regression. Watch `sectionsBudgetDeferred` for a jump.

---

## Patch 2 — Save hit rate is 26% against a 10% floor

**Priority: high. Diagnostic first, then targeted edits.**

### Symptom
`Save100: 26.0%`. `SAVE_INTERVAL = 10` sets a 10% floor, so
`requestImmediateSave()` is forcing saves on ~16% of extra ticks. At 2.602 CPU
per save that is **~0.42 CPU/tick** of avoidable cost.

### Root cause
126 `requestImmediateSave(` call sites, 62 of them in market modules —
`marketPriceAdjustment.js` (31), `marketEconomics.js` (18), `marketBatchBuy.js`
(9), `opportunisticBuy.js` (8). `requestSave()` only arms a checkpoint for the
next %10 tick and is correctly amortized; `requestImmediateSave()` forces
serialization that tick.

### Step 1 — read the existing telemetry, do not guess
`memoryManager.getSerializationReserveStats()` already returns `recentReasons`
via `recentSaveTelemetry()` — a histogram, over the last 100 ticks, of exactly
which programs forced immediate saves (built from `activeImmediateReasons`).

Expose it before changing anything. Either add it to the status line next to the
existing `Save100:` figure, or add a console command. **Rank call sites by
measured frequency, not by grep count** — a file with 31 call sites that fires
twice a day is not the problem.

### Step 2 — convert only the demonstrably hot, non-critical sites
`requestImmediateSave()` exists to protect state that must survive an unexpected
global reset between checkpoints. Converting blindly risks losing in-flight
market state on a reset.

Convert only where **both** hold:
- `recentReasons` shows the site firing frequently, and
- losing up to 10 ticks of that state is recoverable (a repricing timestamp, a
  cached quote, a counter) rather than authoritative (a placed order id, a
  credit commitment, a capacity lock id).

Keep immediate saves for anything recording a completed market transaction or an
external order id.

**Scope limit: `marketPriceAdjustment.js` and `marketEconomics.js` only in this
patch.** `marketSell.js` and `autoTrader.js` are VFS-migration files — defer.

### Verification
`Save100:` drops toward 10-15%. Recompute expected saving as
`2.602 * (oldRate - newRate)`.

### Risk
Medium — this is the only patch that can lose data. Land it after Patch 1, one
file at a time, and watch for market state inconsistencies after any global
reset.

---

## Patch 3 — MarketBuy / MarketRefine create-cancel loop burning credits

**Priority: high. Credits, not CPU.**

### Symptom
```
Cancelled 6a8ce8e0 (H in W4N49) - break-even ceiling unavailable | filled 0/6000 | fees paid 5935.7 (sunk)
MarketRefine: order missing/cancelled. Recreating for remaining 6000 @ 59.357 (ceiling 201.306)
Cancelled 6a8ce926 (H in W4N49) - break-even ceiling unavailable | filled 0/6000 | fees paid 5935.7 (sunk)
MarketRefine: Recreating for remaining 6000 @ 59.357 (ceiling 201.306)
```
**~11,871 credits sunk in two aborted cycles** before the third order survived.

### Root cause — an asymmetry between two ceiling sources
`marketBuy.js:242`, inside `repriceUpIfNeeded`:

```
var t = pricing.breakEvenInputCeilings(e.job.product);
var i = t ? t[e.resource] : null;
if (typeof i !== "number" || !(i > 0)) {
  this.cancelOrderById(e.orderId, "break-even ceiling unavailable", e.opId || null);
  return false;
}
```

`marketRefine.js:744` `ensureMarketBuyOrder` then sees the order gone and
recreates it from `r.maxPrice`, the ceiling captured when the refine op started —
which is still perfectly valid (201.306).

So `marketBuy` consults a **live** lookup and treats a transient miss as
terminal; `marketRefine` holds a **stored** ceiling and rebuilds. Each cycle
sinks the order-creation fee. That the third order later succeeded and
up-repriced to 201.306 proves the failure was transient.

Note the order already carries a valid fallback: the very next lines of
`repriceUpIfNeeded` read `e.jobCeiling`.

### Fix
Two parts.

**3a — `marketBuy.js`, `repriceUpIfNeeded`: never cancel from a repricing path.**
When `breakEvenInputCeilings` yields nothing, fall through to `e.jobCeiling`. If
that is also unavailable, **skip the reprice this tick** (`return false`) and
leave the order alone. A function whose job is repricing should abort the
reprice, not destroy the order.

If a genuine terminal condition must still cancel, gate it behind a consecutive
failure counter on the order record (suggest 5+ consecutive misses) so transient
lookup gaps cannot trigger it.

**3b — `marketRefine.js`, `ensureMarketBuyOrder`: add a recreate circuit
breaker.** There is currently no recreation counter, so this can loop
indefinitely, sinking fees each pass. Track recreations per op; after N (suggest
2) stop recreating and take the existing `useMarketBuy = false` fallback to
`createOpportunisticBuyForInput`, which the function already implements for the
no-passive-bid case.

3a alone should stop the observed loop. 3b bounds the cost of any future
disagreement between these two modules.

### Verification
No `break-even ceiling unavailable` cancellations with `filled 0/N`. Track total
sunk fees across a day against the `DailyFinance` expense line.

### Risk
Low-medium. 3a makes cancellation strictly rarer, so the failure mode becomes a
stale order lingering rather than credits burning — cheaper and more visible.

---

## Patch 4 — One suspended room defeats the spawn interval gate

**Priority: medium-high. Largest clean CPU item, but confirm by measurement
first.**

> Correction: an earlier suggestion to memoize `getRoomState.get` /
> `isSingleSourceActive` inside `spawnManager` was wrong. Those calls are cheap —
> 2935 + 2413 calls over 100 ticks total only ~5.4 CPU, about 0.05 CPU/tick.
> `spawnManager` self time is 132.6 (1.33 CPU/tick) and is **not** in those
> helpers. Do not spend effort on memoization.

### Symptom
`spawnManager.run` costs 1.58 CPU/tick, 84% of it self time, running every tick
while spawning roughly two creeps per 100 ticks.

### Root cause
`spawnManager.js:4317` `run()` is already well interval-gated — nearly every
`manage*Spawns()` is behind `Game.time % 5` or `% 10`. The expensive path is:

```
if (needsNewCreeps(e) || Game.time % 10 === 0) {
  manageSpawnsPerRoom(e);
}
```

`needsNewCreeps` (spawnManager.js:4453):

```
for (const t in e) {
  const a = e[t];
  var r = 0;
  for (var o in a) r += a[o];
  if (a.harvester === 0) return true;
  if (r < 3) return true;
}
```

The `e` argument is `statusReport.getPerRoomRoleCounts()`, which enumerates
**every owned room** (`o.controller && o.controller.my`) and zero-initialises all
role counters.

**E1N46 is suspended and holds no creeps.** Status shows
`E1N46 RCL6 | En:300/2.3k | Sto:359k | Idle` with no creep icons, and the log
prints `[Spawn] E1N46: skipped, room suspended`. So `a.harvester === 0` is true
for E1N46 on every tick, `needsNewCreeps` returns true on every tick, and
`manageSpawnsPerRoom` runs **every tick instead of every 10** — for all ten
rooms — even though E1N46 is then skipped inside the loop as suspended.

`needsNewCreeps` has no suspension awareness; the suspension check lives further
down inside `manageSpawnsPerRoom` (spawnManager.js:1450).

### Fix
Make `needsNewCreeps` skip suspended rooms. Reuse the existing pattern at
spawnManager.js:4255:

```
var susp = Memory.suspendedRooms && Memory.suspendedRooms[rn];
```

Skip any room where that is truthy before evaluating `harvester === 0` or
`r < 3`.

**Do not remove or weaken the check itself.** It exists so a room that loses all
harvesters gets an immediate response instead of waiting up to 10 ticks. The bug
is only that a permanently-empty suspended room trips it permanently.

### Measure before and after — this estimate is inference, not measurement
Wrap `manageSpawnsPerRoom` (and `manageRepairerSpawns`, the one `manage*`
function with no interval gate, 98 lines at spawnManager.js:4061) in their own
profiler sections and capture 100 ticks **before** editing. If
`manageSpawnsPerRoom` is the bulk of the 132.6 self time and drops to a tenth of
its invocations, the saving approaches 1.0 CPU/tick. If it is not, the real cost
is elsewhere in the 4,504-line file and this patch is worth much less.

### Verification
- `spawnManager.run` cpu/tick in a fresh `profileFor(100)`.
- Spawn responsiveness unchanged: kill a harvester in a live room and confirm a
  replacement is queued within one tick, not ten.

### Risk
Low, provided the emergency path is preserved. The one regression to watch: if a
room is suspended *while* genuinely needing an emergency spawn, it is now
invisible to the fast path — acceptable, since suspended rooms are skipped by
`manageSpawnsPerRoom` regardless.

---

## Suggested landing order

1. **Patch 1** — one constant plus a cold-start default; unblocks correct
   budgeting and makes every later measurement trustworthy.
2. **Patch 4 measurement** — instrument `manageSpawnsPerRoom`, capture 100 ticks.
3. **Patch 3** — independent of the CPU work, stops credit burn.
4. **Patch 4 fix** — apply once measurement justifies it.
5. **Patch 2** — diagnostic first, then the two safe files; highest data-loss
   risk, so land last and slowly.

Re-run `profileFor(100)` and `memoryProfile()` after 1+4 to re-baseline before
attempting 2.

## Expected combined result
Roughly 0.4-1.5 CPU/tick recovered (dominated by Patch 4, contingent on its
measurement), correct budget reserve accounting, an end to the recurring ~5.9k
credit sink, and a bucket that stops draining. None of this touches the intent
cost floor — `roleRepairer` at 1.67 CPU/tick of pure intents, `towerManager` at
0.84, `scanner` at 0.46 — which remains a policy question, not a refactor.
