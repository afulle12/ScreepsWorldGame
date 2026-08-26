# Spec — Room Suspender Structure Vitals (revised)

Supersedes the "Fix Room Suspender Structure Decay & Repair Management"
proposal. The underlying gap is real; the thresholds, scope, and safety model in
v1 are not shippable as written.

Verified against the canonical root runtime.

---

## 1. What is actually broken

`computeVitals()` (roomSuspender.js:424) tracks only `towerMinPct` and
`roadMinPct`. Containers and ramparts are absent. `getIneligibilityReason()`
(roomSuspender.js:476) therefore cannot wake a suspended room whose containers
or ramparts are decaying, and suspended rooms are skipped by both repair
planning (repairManager.js:2092) and tower work (towerManager.js:259).

Suspension here is not brief. `SUSPEND_BUCKET = 2800`, `RESUME_BUCKET = 3500`,
and this colony's bucket sits at 2,900–3,200 and rarely reaches 3,500 — E1N46
currently shows `planAge:8609`. Decay-to-threshold times confirm the exposure:

| Structure | Decay rate | Ticks to reach a meaningful floor |
| --- | --- | --- |
| Rampart | 3 hits/tick | fastest of the three |
| Container | 10 hits/tick (250k max) | ~15,000 to 40% |
| Road | 0.1 hits/tick (5k max) | ~32,500 to 35% |

**Containers and ramparts are the gap. Roads are not.**

---

## 2. Blocking corrections to v1

### 2a. Rampart thresholds are wrong by two orders of magnitude

v1 proposes 25,000 hits emergency / 60,000 healthy. The repair manager's own
constants are:

```
WALL_EMERGENCY_HITS              = 1e6      (repairManager.js:111)
RAMPART_EMERGENCY_HITS           = 1e6      (repairManager.js:112)
CRITICAL_RAMPART_EMERGENCY_HITS  = 5e6      (repairManager.js:113)
```

v1's "healthy" bar of 60k is **16× below** what `repairManager` treats as an
emergency. A room with ramparts at 100k hits would be judged healthy and
suspended by the suspender while `repairManager` simultaneously classifies it
`PEACE_EMERGENCY` and tries to emergency-repair it. The two systems would
actively fight.

**Required:** export `WALL_EMERGENCY_HITS`, `RAMPART_EMERGENCY_HITS`, and
`CRITICAL_RAMPART_EMERGENCY_HITS` from `repairManager.constants`
(repairManager.js:2491, which already exports `RAMPART_TARGETS`,
`BREACH_MIN_RCL`, `BREACH_RECHECK_TICKS`, `BREACH_MAX_NODES`) and consume them
in `roomSuspender`. **Do not restate any threshold numerically in
`roomSuspender.js`.**

Set the healthy re-entry bar as a modest multiple of the emergency constant
(suggest 1.5×), **not** the full RCL repair target from `getRampartTarget()`.
Requiring a full repair target before a room may be suspended would make
suspension nearly unreachable — see 2b.

### 2b. The hysteresis can disable CPU shedding when it is most needed

`isEligibleForSuspension()` (roomSuspender.js:489) is `!getIneligibilityReason()`,
and `run()` uses that **same predicate in both directions**: to force a suspended
room awake, and — via `buildSuspendCandidates()` — to decide whether an active
room may be suspended at all.

Under a dual-threshold model, any room that degrades below the healthy bar
becomes permanently un-suspendable until repaired back up. Under sustained CPU
pressure repairs are slow, so rooms accumulate in "awake, degraded, ineligible"
and the candidate pool shrinks toward empty. `isUnderCpuPressure()` stays true
with nothing left to suspend.

**The suspender's capacity to shed CPU would decay in proportion to how long it
has been shedding CPU.** The recent bucket-zero incident is the proof case: four
rooms sat in `PEACE_EMERGENCY` with degraded ramparts while the bucket hit 0.
Under v1 all four would have been locked out of suspension during the exact
window where shedding was survival-critical.

**Required:** add a bucket-floor override in `getIneligibilityReason()`. Below a
`CRITICAL_BUCKET_OVERRIDE` floor (suggest 1000), structure-health reasons —
`containerDamage`, `rampartDamage`, `roadDamage`, `towerDamage` — are ignored and
the room stays suspendable. Survival outranks infrastructure; a decayed container
is recoverable, a dead colony is not.

Hard blocks (`getHardBlockReason`, hostiles, `economyCreepGap`, `breach`) must
**not** be overridden.

### 2c. Priority contradiction

v1 both hard-excludes rooms below 75% container / 65% road health *and* proposes
a priority penalty for the 40–75% and 35–65% bands. Hard-excluded rooms never
reach scoring, so the penalty is unreachable.

**Resolution:** keep hard exclusion. Apply the `getSuspensionPriority()` penalty
only to rooms **above** the healthy entry threshold that are trending toward it
— so pristine rooms suspend before nearly-degraded ones.

---

## 3. Scope changes

### Dropped: removing `ROAD_SAMPLE_CAP`

`ROAD_SAMPLE_CAP = 100` (roomSuspender.js:18) stays. Removing it is the largest
scan-cost increase in the proposal and targets the slowest-decaying structure in
the room (~32,500 ticks to threshold vs ~15,000 for containers). If unmonitored
roads must be covered, rotate the sample window by offset across `VITALS_TTL`
cycles instead of uncapping.

### Cost framing

`VITALS_TTL = 25` with a heap-backed cache, so vitals recompute once per room per
25 ticks. Adding containers (~5–10) and ramparts (~50–150) to the existing
~106 reads keeps the total well under 0.05 CPU/tick across ten rooms, on objects
`getRoomState` has already indexed. **The scan cost is acceptable.** The breach
BFS is the only meaningful cost and is separately cached at
`BREACH_RECHECK_TICKS = 25`.

Describe the guarantee in docs and status output as **"no gameplay work"**, never
"zero CPU" — suspended rooms still pay room-state scanning, defense monitoring,
creep iteration, suspension checks, and this vitals scan.

---

## 4. Implementation

### 4a. `computeVitals()` (roomSuspender.js:424)

`getRoomState.get(room).structuresByType` is built generically and already
indexes every structure type present, so containers and ramparts are available
with no changes to `getRoomState`.

Add:
- `containerMinPct`, `containerCount` — scan all containers.
- `rampartMinHits`, `rampartCount` — scan all ramparts. **Filter to owned,
  non-public ramparts only** (`r.my && !r.isPublic`), consistent with repair
  logic; foreign or public ramparts must not wake a room.
- Keep `towerMinPct`, `towerCount`, `hasTowers`, `roadMinPct` unchanged.

Use nullable minimums (`null` when the count is zero) so "no containers" is
distinguishable from "containers at 0%".

**Scope note for docs:** scanning existing structures cannot detect that an
expected structure has been *removed*. Only breach detection covers missing
perimeter ramparts. State this explicitly rather than implying "minimums detect
missing structures".

### 4b. Tower energy

v1's summary mentions tower energy but its vitals track only hits. **Remove
energy from scope.** Add it later as a separate rule if wanted.

### 4c. Breach integration

`getBreachState(roomName, roomState, rcl)` takes **three** arguments
(repairManager.js:1349). Calling it with only `roomName` yields an invalid
result. Call it as:

```
getBreachState(roomName, getRoomState.get(roomName), Game.rooms[roomName].controller.level)
```

`repairManager` already has a **top-level** `require("roomSuspender")`
(repairManager.js:73). To avoid a cycle, resolve `repairManager` through a
**deferred require inside a helper**, matching the existing pattern at
`getRepairHardBlockReason()` (roomSuspender.js:387). Do not add a top-level
import, and do not call `buildPlan()` from the suspender.

Breach is a **safety exclusion**, not a health metric — a 1-hit rampart still
blocks the BFS, so `rampartMinHits` remains a separate, independent check.
Report `breach` separately from activity hard blocks in status and plan output.
Respect `BREACH_MIN_RCL` and safe mode.

### 4d. Dual-mode thresholds

Two named modes rather than a single constant:
- **Entering suspension** (active room): healthy thresholds.
- **Staying suspended** (resumption check): emergency thresholds.

`MIN_STRUCTURE_HEALTH = 0.5` (roomSuspender.js:15) is currently used for both;
replace with the mode-aware pair. Rampart values come from the newly exported
repair constants (2a), never restated locally.

### 4e. Ordering

`roomSuspender.run()` executes before `repairManager` and `towerManager`, so a
room resumed this tick can repair on the same tick. Keep both managers skipped
while suspended. No change needed — verify it still holds after the edit.

### 4f. Status output

`status()` (roomSuspender.js:678) iterates only `getSuspendedRooms()`. Print
health metrics for **every owned room**, and include container %, rampart min
hits, road %, and breach state in both `status()` and `suspensionPlan()`.

---

## 5. Tests

New root-based `test/room_suspender_harness.js` importing `../roomSuspender`.
The existing repair harness mocks `roomSuspender` (test/repair_manager_harness.js:71)
and will not cover this.

Test **state transitions**, not just predicates:

| Case | Expected |
| --- | --- |
| Active room, containers 45% | stays active (below healthy entry bar) |
| Active room, containers 70% | stays active |
| Active room, containers 80% | eligible to suspend |
| Suspended room, containers 70% | stays suspended |
| Suspended room, containers 35% | resumes (`containerDamage`) |
| Suspended room, ramparts below `RAMPART_EMERGENCY_HITS` | resumes (`rampartDamage`) |
| Breach detected | ineligible, reason `breach`, reported separately |
| Public / foreign rampart at 1 hit | does **not** wake the room |
| Room with zero containers | no `containerDamage`; nullable minimum respected |
| **Bucket below override floor, containers 20%** | **still suspendable** |
| Hostiles present, bucket below floor | still ineligible (hard block wins) |

The last two are the regression guards for 2b and must not be omitted.

---

## 6. Sequencing

Do not deploy this alongside recovery work. Land in this order:

1. `lastTouchTick` migration fix (root cause of the reservation purge) — pending
2. `needsNewCreeps` suspended-room skip (spawnManager.js:4456) — pending
3. Bucket stable and climbing, repair backlog cleared
4. Then this spec

This changes the CPU-shedding mechanism itself. Shipping it while the colony is
still recovering from a bucket-zero event risks converting a recoverable incident
into an unrecoverable one.

---

## 7. Considered and deferred: passive tower repair while suspended

v1 dismisses this on the grounds that towers exhaust their energy without
suppliers. The arithmetic does not support that: a tower holds 1,000 energy, a
repair shot costs 10 and restores up to 800 hits — **80,000 hits of repair from a
full tower with zero creep CPU and no supplier**. Against 3 hits/tick rampart
decay that is roughly 26,000 ticks of offset on a single rampart, longer than the
window this spec addresses.

A "suspended-room decay watch" — one tower, one repair intent every N ticks,
spending down stored tower energy — needs no state-machine changes and carries
none of the deadlock risk in 2b.

Not part of this spec, but it is the cheaper solution to the same problem and
should be evaluated before investing further in threshold tuning.
