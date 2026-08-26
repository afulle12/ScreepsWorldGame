# Instructions — Complete the VFS Transition and Remove Regressions

Follow-up to the V2 cutover. The cutover itself is sound: the read layer is
built, `_buildingBreakdown` keeps its shape, the heartbeat and mode machine are
gone, V1 deletion is double-gated, and the latent `runMaintenance` cursor bug
(locks past index 50 never expiring) is fixed.

Four items remain. **Task 1 and Task 2 must land before any live deploy** — both
concern the deployment path itself, not code quality.

---

## Task 1 — Both live-health signals are broken (blocker)

The soak plan is "run `vfsParityReport()` and observe divergence for 1,000
ticks." Neither instrument works after the cutover, and they fail in opposite,
equally misleading directions. Both exist to compare two ledgers; with one
ledger left, both are meaningless.

### 1a — `vfsParityReport()` will report total failure by design

Correction to an earlier review note that said this would read clean or empty —
it will not. Trace `getParityReport` with `Memory.storageReservations` deleted:

- `c = Memory.storageReservations || {}` is empty, so the legacy map `i` is empty
  and `legacyTotal` (`a`) is 0.
- The V2 map `u` is populated from active locks; `v2Total` (`l`) is greater than 0.
- The first loop (over `i`) does nothing.
- The second loop (over `u`) hits `if (g[e] && i[e][t] !== undefined) continue;`.
  `g` is only ever populated inside the first loop, so `g[e]` is always
  `undefined` here — **every V2 program-node is recorded as a `v2Only`
  mismatch.**
- Result: `isMatch: false`, `totalsMatch: false` (`l !== 0`), and `mismatches`
  full of false alarms.

**Fix:** make the report aware that V1 is retired. When
`Memory.storageReservations` is absent, either return a distinct
`mode: "v2-only"` result that reports lock inventory and health without
attempting comparison, or have `vfsParityReport` print a clear "V1 retired —
parity comparison not applicable" line instead of a mismatch wall. Do not leave
a tool that reports catastrophic failure as its normal steady state.

### 1b — `vfsDivergence()` is fed by nothing

`recordMirror` (storageVfs.js:254) has **zero callers**. It was only invoked from
`storageManager`'s four dual-write mirror sites, all correctly removed. So
`mirrorOk`/`mirrorFail` stay at 0 forever and `vfsDivergence()` reports a 0.00%
fail rate permanently.

That reads as "healthy" while measuring nothing — the same class of defect as the
`Mem: 0.000` serialization gauge.

**Fix:** delete `recordMirror`, `getDivergence`, `resetDivergence`, the
`divergence` block in `getV2Root()`, and the `global.vfsDivergence` helper. This
is dead dual-write scaffolding. If a health gauge is wanted in its place, see the
revised soak procedure below — but do not keep a gauge with no input.

---

## Task 2 — Stale V2-only locks may permanently block V1 deletion (blocker)

The deletion gate at storageVfs.js:1101:

```
if (failed === 0) {
  const parity = this.getParityReport();
  if (!parity.isMatch || !parity.totalsMatch) failed = parity.nodes.mismatched || 1;
}
```

This requires an **exact bidirectional match** between V1 and V2 before deleting
V1. Any V2 lock without a V1 counterpart is a `v2Only` mismatch and defers the
deletion — every tick, forever, logging
`Legacy reservation migration deferred: N lock(s) failed`.

Test fixtures start with an empty V2, so this always passes there. **The live
shard does not.** `Memory.storageReservationsV2` carries ~31 KB of locks from the
dual-write era. Stale V2-only entries are plausible: when V1's old
`cleanStale(2e4)` removed a record, its V2 mirror survived until its own TTL
expired, leaving a window where V2 held locks V1 did not.

Note the gate is stricter than it needs to be. V2 is becoming authoritative;
extra V2 locks are not a migration failure. Only `legacyOnly` and
`amountMismatch` indicate data that would be lost by deleting V1.

**Do both:**

1. **Before deploying**, run `vfsParityReport()` on the live shard *while V1
   still exists* and record the `v2Only` count. This is the go/no-go.
2. **Relax the gate** to ignore `v2Only`: block deletion only on `legacyOnly` or
   `amountMismatch` (data at risk), not on extra V2 locks. Keep `failed > 0` from
   the import loop as a hard block.

Without change 2, a single stale V2 lock leaves the colony running both ledgers
indefinitely with a per-tick error log — the exact state this migration set out
to end.

---

## Task 3 — Restore stale-reservation cleanup (regression)

`storageManager.cleanStale(2e4)` is gone. It ran every 1,000 ticks from `main.js`
and purged reservations older than 20,000 ticks. The only automatic cleanup now
is TTL expiry in `runMaintenance`, and `TTL_RESERVATION = 1e5`.

An abandoned reservation — program crashed, op aborted without `unReserve` — now
blocks resources for **100,000 ticks instead of 20,000**. `sanitizeReservations`
survives but is console-only; nothing calls it on a schedule.

This is not hypothetical. The pre-migration log captured the exact failure:

```
[marketLab fwd] E3N46/G: selling setup timed out after 7971 ticks; failing operation.
G [stockpileManager@terminal=9233]
```

A stuck reservation starving another module. That path now takes five times
longer to self-heal.

**Fix — preferred:** add an age-based purge to the existing cursor sweep in
`runMaintenance`. It already walks locks with a bounded, advancing cursor, and
the lock schema already carries `createdTick` and `lastTouchTick`. Purge any lock
whose `lastTouchTick` is older than a `STALE_RESERVATION_AGE` constant (use
`2e4`, matching the old `cleanStale` threshold) in the same pass that handles
`expiryTick`. Log purges distinctly from TTL expiries so the two causes stay
separable in the console.

Keep `TTL_RESERVATION = 1e5` as the outer bound. Programs that re-reserve keep
refreshing `lastTouchTick` through `lock()`'s upsert path, so only genuinely
abandoned locks are affected — which is the intent.

**Do not** rely on scheduling `sanitizeReservations` instead: it removes
malformed and inactive locks, not merely old ones, and it is unbounded (it
iterates every lock each call), which is why it belongs on the console rather
than in the tick loop.

---

## Task 4 — Unify the availability accessor (minor, non-blocking)

`storageManager.reserve` computes availability from `getActualAmount`
(`Game.rooms[x].terminal|storage.store[r]`), then `vfs.lock()` independently
recomputes it from `getPhysicalStock` (`resolveStructure` +
`getUsedCapacity`). Two code paths answering one question.

They should agree today, but `reserve`'s rejection message is built from a
different source than the check that actually rejects, so any future divergence
surfaces as a confusing error rather than a caught bug. Two independent views of
the same number is what produced the V1/V2 split originally.

**Fix:** have `storageManager.reserve` drop its own pre-check and rely on
`vfs.lock()`'s, surfacing the reason `lock()` returns. `lock()` already performs
the identical computation and returns a formatted
`"Insufficient available resources"` reason.

---

## Revised live-soak procedure

Replace the original "observe divergence" step, which cannot work:

1. **Pre-deploy, V1 still present:** run `vfsParityReport()`. Record
   `legacyOnly`, `amountMismatch`, and `v2Only` counts. Non-zero `legacyOnly` or
   `amountMismatch` is a stop — investigate before deploying. Non-zero `v2Only`
   is expected and is what Task 2 handles.
2. **Deploy.** Confirm a single
   `Migrated N legacy reservations ... and removed V1` line, and that it does not
   repeat. A repeating `migration deferred` line means Task 2 was not applied
   correctly.
3. **Over 1,000+ ticks, watch signals that have a live source:**
   - `vfsStatus()` — active lock and capacity-lock counts should stay bounded,
     not grow monotonically. Monotonic growth means locks are leaking.
   - `runMaintenance()` return values — `expiredLocks` and the new stale-purge
     count. A persistent zero across a full cursor sweep while lock count climbs
     indicates the sweep is not reaching them.
   - Rate of `"Insufficient available resources"` rejections from `reserve`. A
     rise over baseline is the signature of over-reservation or leaked locks.
   - Absence of the `stockpileManager@terminal=` starvation pattern in
     `marketLab` logs.
4. **Confirm the CPU win:** `profileFor(100)`. `storageManager.heartbeatVfsReservations`
   should be gone entirely (it was 0.46 CPU/tick), and `storageVfs.maintenance`
   should stay small.

---

## Acceptance criteria

- `vfsParityReport()` returns a coherent result post-migration; no mismatch wall.
- No `vfsDivergence` gauge reporting from a dead input.
- `Migrated ... and removed V1` appears exactly once; no repeating deferral log.
- `Memory.storageReservations` absent; `Memory.storageReservationsV2` present and
  not growing without bound.
- A stale-lock purge path exists, is bounded, runs automatically, and is covered
  by a regression test asserting that a lock untouched for
  `STALE_RESERVATION_AGE` is removed.
- Existing suites still green: full VFS suite, stockpile harness, boost and
  market harnesses.

## Out of scope

Do not touch `memoryManager.js` beyond what the VFS work already required — the
four CPU/credit patches in `docs/cpu-credit-patch-plan.md` are queued separately
and Patch 1 edits that file.
