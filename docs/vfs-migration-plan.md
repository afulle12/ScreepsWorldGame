# VFS Migration Plan — Retiring the V1 Reservation Ledger

Goal: make `Memory.storageReservationsV2` (storageVfs) the sole reservation
ledger, delete `Memory.storageReservations` (storageManager V1), and remove the
per-tick heartbeat that exists only to bridge the two.

## 1. Verified current state

### Write path — V1 authoritative
`storageManager.reserve / transfer / unReserve / consume` write V1, then mirror
into V2 via `lock` / `mv` / `unlock` / `write`, guarded by
`getMode() === "dualWrite" || "v2Authoritative"` and wrapped in silent
`try {} catch (e) {}`.

Mirror sites: `storageManager.js` lines 223, 327, 389, 467.

### Read path — split, and this is the problem
V1 reads (unconditional — they ignore mode entirely):

| Location | Function |
| --- | --- |
| storageManager | `getReservations`, `getTotalReserved`, `findReservationIndex` |
| storageManager | `_buildingBreakdown` (backs all 54 `storageFind` call sites) |
| storageManager | `reserve` availability check — the correctness core |
| storageManager | `getUnreserved`, `printUnreserved`, `listReservations` |
| storageManager | `validateReservations`, `sanitizeReservations`, `cleanStale` |
| boostManager.js:301,537 | direct `Memory.storageReservations` read |
| marketSell.js:1617 | direct read |
| roleLabBot.js:85 | direct read (fallback after V2 miss) |
| stockpileManager.js:320 | direct read |

V2 reads already live in production (direct `stat()`, silent fallback on miss):

| Location | Reads |
| --- | --- |
| boostManager.js:293 | lock amount by program |
| roleLabBot.js:77 | boost lock amount, falls back to V1 |
| autoTrader.js:3396 | terminal + storage `available` and lock amounts |
| roleTowerFiller.js:88 | energy `available`, falls back to raw store |
| roleUpgrader.js:117 | storage energy `available`, falls back to raw store |

**Consequence: V2 is not a shadow copy. Five modules already trust it.
Deleting V2 would break them. V1 cannot simply be kept either — the two are
load-bearing simultaneously.**

### The mode machine is decorative
`initMode` accepts `shadow | dualWrite | v2Authoritative | rollback`. All four
`getMode()` consumers live in storageManager and test the same predicate
("should I mirror?"). `shadow` and `rollback` are unreachable. **`v2Authoritative`
is behaviourally identical to `dualWrite`** — no read path consults the mode.

### Capacity subsystem — V2-only, live, no V1 equivalent
`lockCapacity / reduceCapacity / extendCapacity / resizeCapacity /
unlockCapacity / touchCapacity` reserve *incoming* terminal capacity for pending
buy orders. Used by `marketBuy.js` and `marketBatchBuy.js`. V1 tracks only
outgoing resources. This subsystem is unaffected by the migration and must be
preserved as-is.

### Cost being recovered

| Item | CPU/tick | Note |
| --- | --- | --- |
| `heartbeatVfsReservations` | 0.46 | 100% self; O(all V1 reservations) scan **every tick** — the cursor bounds only the touch phase, not the scan |
| V1 Memory (3,217 B, 0.86%) | ~0.02 | serialization share |
| Mirror overhead in write path | unmeasured | folded into storageManager |
| **Total** | **~0.50** | ~2.5% of a saturated 20 CPU budget |

`Memory.storageReservationsV2` is 31,117 B (8.27%, ~0.21 CPU/tick) and **stays**.
Trimming it is a separate task (Phase 5).

### Non-issues (checked, ruled out)
- **Nuker paths**: `storageVfs` defensively excludes them, but nothing creates
  nuker reservations — `storageManager.reserve` rejects any building that is not
  terminal/storage. Dead defensive code, not a blocker.
- **Unmirrored writes**: all four out-of-module `Memory.storageReservations`
  accesses are reads. No write bypasses the mirror, so parity is achievable.

---

## 2. Endpoint

- `Memory.storageReservations` deleted
- `heartbeatVfsReservations` deleted
- mode machine deleted
- `storageManager` becomes a thin compatibility facade over V2, or is folded in
- capacity subsystem untouched

---

## 3. Phases

### Phase 0 — Baseline and go/no-go (no behaviour change)
1. Run `vfsParityReport()` on the live shard. Record `legacyOnly`, `v2Only`,
   `amountMismatch`, `malformed` counts.
2. Run `storageVfs.getDivergence()`. Record `failRate` over >= 1000 ticks.

**Gate:** `failRate` ~0 and zero `amountMismatch`. If parity is already broken,
the mirror has a bug — fix that before touching anything else. Everything
downstream assumes the mirror is correct today.

### Phase 1 — Build the read side (the missing piece)
The migration was never half-done; **the V2 read layer does not exist**. This is
the bulk of the work.

1. Add to `storageVfs`:
   - `getReserved(room, building, resource)` -> total active locked amount
   - `getAvailable(room, building, resource)` -> physical stock minus locked
   - `getReservationList(room, building, resource)` -> V1-shaped
     `[{program, amount, time}]` records
2. Rewrite `storageManager._buildingBreakdown` to source from V2 when mode is
   `v2Authoritative`, V1 otherwise. **Return shape must be byte-identical** —
   `{terminal:{total,reserved,available,reservations}, storage:{...},
   combined:{...}}` — because 54 `storageFind` call sites depend on it.
3. Route `reserve`'s availability check through the same accessor.
4. Port the four out-of-module direct readers (`boostManager`, `marketSell`,
   `roleLabBot`, `stockpileManager`) onto the new accessors.

**Gate:** `test/centralized_stockpile_harness.js` and
`test/boost_order_capture_harness.js` pass with mode forced to both values.
Add a harness that asserts V1 and V2 breakdowns are identical over a seeded
fixture.

### Phase 2 — Flip reads to V2
Set mode `v2Authoritative` — which now actually means something.

V1 is still written, so `getParityReport` stays meaningful and **reverting is a
single mode flip back to `dualWrite`**. This is the reversible observation
window.

**Gate:** N ticks (suggest 5,000) with zero parity mismatches and no
resource over-commitment incidents.

### Phase 3 — Stop writing V1
1. Make `reserve / transfer / unReserve / consume` write V2 only.
2. **Delete `heartbeatVfsReservations`** — its only job was keeping V2 locks
   alive from V1 data. This is where the 0.46 CPU/tick lands.
3. Replace TTL semantics (see Risk 1).

**Gate:** measured CPU drop in `storageVfs.maintenance` section; no expired-lock
log spam from `runMaintenance`.

### Phase 4 — Delete V1
Remove `hydrateReservations`, `ensurePath`, `getReservations`,
`getTotalReserved`, `findReservationIndex`, `releaseVfsReservation`,
`importLegacyReservations`, `cleanStale`, `sanitizeReservations`, the mode
machine, and `Memory.storageReservations` itself.

Port console helpers (`printFind`, `listReservations`, `printUnreserved`,
`validateReservations`) onto V2. Drop `memoryManager.hydrateStorageReservations`
and `compactStorageReservation` if they have no other callers.

### Phase 5 — Shrink V2 (separate win)
V2 is now the whole ledger at 31 KB / ~0.21 CPU/tick. Trim `lockIndex`
redundancy against `locks`, drop `orphans` (TTL-pruned scaffolding from the
import path), and compact expired `nodes`.

---

## 4. Risks

1. **TTL semantics change — the big one.** Mirrored locks use `TTL_LEGACY`
   (20,000) refreshed by the heartbeat. Native V2 locks expire on their own TTL.
   Once the heartbeat is gone, any reservation held longer than its TTL without a
   `touch()` **silently expires** where V1 held it indefinitely. Audit every
   long-lived program (`marketRefine`, `marketBuy` queued orders, `boostManager`)
   and give each an explicit touch cadence or a long TTL before Phase 3.
2. **Silent `try/catch` everywhere.** All five V2 readers and all four mirror
   sites swallow errors. During Phases 2–3 a V2 bug surfaces as *slightly wrong
   numbers*, not a crash. Add temporary logging inside those catch blocks for the
   duration of the migration.
3. **`reserve`'s availability check is the correctness core.** If V2
   under-reports reserved amounts, programs over-commit the same resources and
   the failure is economic, not a thrown error. Test this path first and hardest.
4. **Phase 3 is the irreversible step.** Phases 0–2 revert with a mode flip.
   Once V1 writes stop, V1 data goes stale within ticks and rollback means
   re-importing from V2.

---

## 5. Honest cost/benefit

~0.50 CPU/tick (2.5% of a saturated budget) plus the removal of a genuinely
confusing dual-ledger state, in exchange for building a read layer that does not
exist yet and one irreversible cutover. The cleanup value is arguably higher than
the CPU value — the current split-read architecture is a live correctness hazard
that nobody would design on purpose.
