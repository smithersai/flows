# Review: `@smthrs/step-cache` vs Bazel Skyframe

Date: 2026-08-19. Package: `flows/packages/step-cache` (src @ current working tree).
Prior art: `reference/bazel/src/main/java/com/google/devtools/build/skyframe` and, where
the package itself cites it, `reference/bazel/.../lib/remote`.

## Scope calibration

`step-cache` is not a Skyframe evaluator. It is the durable content-addressed
result store: a head table (`flows_step_cache`), an append-only provenance
ledger (`flows_step_cache_recorded`), a two-tier local/remote composition, and
a dumb-HTTP remote tier. The Skyframe areas that live *outside* this package —
node dirtying and change pruning, dependency bookkeeping, cycle detection,
error bubbling, partial re-evaluation — are implemented by its consumers
(`engine-store/src/internal/ActionPersistence.ts` does the Skyframe-style
dirty check at lines 788–795 and Skyframe-style invalidation at 958–979) and
are out of scope here. This review holds the package to the invariants that
*do* land in a memoizing store: version/provenance discipline, reuse
correctness, invalidation soundness, atomicity under interruption, and the
inconsistency-surfacing posture of `GraphInconsistencyReceiver`.

Findings are ranked. Evidence lines refer to the files as read today.

---

## Finding 1 — HIGH: the fenced `get` falls back to the mutable head silently, so replay of non-recording frames is not a function of durable state

**Our code.** `GetOptions.recordedBy` promises that "an old frame's projection
stays a function of durable state: evicting or replacing the head never
changes what that event recorded" (`src/CacheStore.ts:101–114`). The
implementation delivers that only when the fence names a ledger row. When the
ledger misses, `get` returns the head with no signal that the fence was not
satisfied (`src/CacheStore.ts:320–349`): the caller cannot distinguish "exact
recorded bytes" from "whatever the head holds today".

**Why the fallback is hit in practice.** The one fenced consumer is time-travel
replay, which fences every cache-carrying journal entry with its *own*
coordinates: `cache.get(cacheKey, { recordedBy: { runId: options.runId,
eventSeq: entry.seq } })` (`time-travel/src/internal/Replay.ts:112`). Only the
`recorded` provenance record's seq equals the entry's `recordedEventSeq`
(`ActionPersistence.ts:629–646`). Every *other* cache-carrying record — the
sealed-tier attempt lifecycle records that carry `cacheKey`
(`ActionPersistence.ts:762`) and any frame whose run reused a row recorded by
another run — misses the ledger and replays the head.

**Why the head moves.** The engine's own sanctioned flows replace the head
under an unchanged digest: the stale-read-set path evicts and lets the
re-execution "record cleanly under the same key"
(`ActionPersistence.ts:958–979`), and corruption quarantine does the same
(`ActionPersistence.ts:893–913`). After either, replaying an old hit-frame
serves the *new* result. The projection silently diverges from what the run
observed. Note the durable pointer needed to do this right already exists: the
verified-hit record journals the recorder's `recordedRunId`/`recordedEventSeq`
(`ActionPersistence.ts:826–835`), but `Replay.ts:52` decodes only `cacheKey`
and never uses it.

**Skyframe counterpart.** A Skyframe value observed at a version is stable:
`NodeVersion.java:19–39` — re-evaluation to an equal value keeps
`lastChanged`, and a dep at a version `atMost` the node's evaluated version is
by definition the same value the node saw. Skyframe never silently substitutes
a value from a different version; Temporal (the repo's other durability
reference) fails replay on nondeterminism rather than diverging silently.

**Fix shape.** Either (a) make `get` report which source answered
(`ledger | head`) so replay can fail closed or journal the divergence, or
(b) fail/flag the fenced read when the ledger misses *and* the head's
`(recordedRunId, recordedEventSeq)` differs from the fence, and fix
`Replay.ts` to fence with the journalled recorder provenance where the record
carries one. Today's shape is (silent fallback) the worst of both.

---

## Finding 2 — HIGH: `CombinedCacheStore.get` drops the provenance fence on the conflict re-read

**Our code.** On a local miss + remote hit, the write-back may lose to a
sibling's concurrent `put` (`Conflict`), and the code re-reads the durable
local row to serve it — but drops the caller's `options`:

```ts
const durable = yield* local.get(keyDigest)          // src/CombinedCacheStore.ts:90
```

The write-back's ledger insert is unconditional and commits even when the head
insert conflicts (`src/CacheStore.ts:360–372`: ledger lands "first and
unconditionally", `ON CONFLICT ... DO NOTHING`, and a `Conflict` outcome is a
committed value, not a failure). So at line 90 the local *ledger* already holds
the exact recorded row the fence names; passing `options` through would serve
it. Instead a fenced caller — a replay — is handed the sibling's *different*
result. This is precisely the "cache collision the caller cannot detect" the
adjacent comment (lines 87–89) says the branch exists to prevent, inflicted on
the one caller class that stated its provenance.

**Skyframe counterpart.** Same invariant as Finding 1 (`NodeVersion.java:26–39`);
the fence is this store's version token and must bind through every tier.

**Fix.** `local.get(keyDigest, options)`. One-word change; the unfenced path is
unaffected because without `recordedBy` the two calls are identical.

---

## Finding 3 — MEDIUM-HIGH: `RemoteCacheStore.get` ignores `GetOptions`; the HTTP protocol has no recorded-version read

**Our code.** The remote `get` signature drops the options parameter entirely
(`src/RemoteCacheStore.ts:92`: `(keyDigest: string) => ...`), and `GET
/ac/{key}` carries no provenance (`src/RemoteCacheStore.ts:88`). Yet
`CombinedCacheStore.get` forwards the fence and documents that "each tier
answers with its recorded version when it holds one and its head otherwise"
(`src/CombinedCacheStore.ts:72–76`). That claim is false for the remote tier: a
fenced replay that misses locally is served the remote *head* — any version,
any provenance — and (per Finding 2's mechanics) it is then written back
locally as if it were the recorded evidence.

The asymmetry is already solved elsewhere in the same file: `evict` rides its
fence as `recordedRunId`/`recordedEventSeq` URL params so the server can CAS
(`src/RemoteCacheStore.ts:163–174`). `get` should send the same params and the
protocol should define the recorded-version read (or the remote tier should be
excluded from fenced lookups so the fence degrades *visibly*, per Finding 1's
fix).

**Counterpart.** Bazel's remote action cache never claims version pinning — but
it also never promises it. Our `GetOptions` doc does (`src/CacheStore.ts:103–109`).
The bug is the unkept promise, and TypeScript's parameter-arity subtyping made
it silent.

---

## Finding 4 — MEDIUM: the remote `Conflict` signal is undecidable — non-canonical body plus per-writer provenance fields

**Our code.** `RemoteCacheStore.put` delegates the `ExistingSame`/`Conflict`
decision to the server ("`409` … it held a *different* one",
`src/RemoteCacheStore.ts:70–75, 149–151`) but gives the server no basis to
decide it correctly:

1. The body is `bodyJsonUnsafe(encoded)` (`src/RemoteCacheStore.ts:147`) —
   `JSON.stringify` key order. The module canonical-*checks* `result` and
   `meta` (lines 143–144) and then discards the canonical text. A server that
   compares bytes sees two structurally equal results built in different key
   orders as different — the exact spurious-`Conflict` bug the local store
   fixed by canonicalizing on the way in (`src/CacheStore.ts:200–216`).
2. The body embeds `createdAtMs`, `recordedRunId`, `recordedEventSeq`, which
   differ for every writer. Two machines recording the *identical result*
   therefore always produce different bytes, so any byte-comparing server
   answers `409` for the routine benign race.

`docs/specs/Concepts/Remote Cache.md` never states the server's comparison
rule (no mention of 409/Conflict at all), so nothing pins the correct
implementation ("compare canonical `result` only", which is the local rule at
`src/CacheStore.ts:383–392`).

**Blast radius.** Through `CacheSync` the outcome is discarded, so today the
misclassification is masked (`engine-store/src/CacheSync.ts:106–113`). But
`RemoteCacheStore.layer` composes the remote tier directly as the `CacheStore`
tag (`src/RemoteCacheStore.ts:195–198`), where a spurious `Conflict` feeds the
strict `Inconsistency` verdict and fails the run
(`ActionPersistence.ts:708–729`) — a `CacheConflictDetected` naming a
divergence that does not exist, which is verbatim the failure mode the
canonicalization comment says was already fixed once.

**Skyframe counterpart.** Change pruning compares *values* structurally, never
serialization accidents or metadata:
`DirtyBuildingState.unchangedFromLastBuild` (`DirtyBuildingState.java:214–219`,
`getLastBuildValue().equals(newValue)`) and
`IncrementalInMemoryNodeEntry.java:169–186`.

**Fix.** Publish the canonical serialization (`encodeCanonical` output is
computed and thrown away today) and specify in `Remote Cache.md` that the
server's conflict comparison is canonical `result` bytes only.

---

## Finding 5 — MEDIUM: a shared-tier outage fails lookups (and therefore dispatches) instead of degrading to a miss

**Our code.** `CombinedCacheStore.get` propagates any remote failure
(`src/CombinedCacheStore.ts:76`), and no consumer downgrades it: engine-store
contains zero handlers for `persistence_failed`, and the dispatch path fails
on a failed `cache.get` (`ActionPersistence.ts:783`). With the documented
production shape ("the intended production shape is `CombinedCacheStore`, with
this as its remote tier", `src/RemoteCacheStore.ts:190–192`), a shared-cache
outage turns every local-miss lookup into a run failure.

This contradicts the repo's own posture — "a shared cache is an accelerator …
failing a completed run because an optional tier is unreachable trades a real
result for an unavailable one" (`engine-store/src/CacheSync.ts:23–28`) — which
is currently enforced for publication only.

**Bazel counterpart.** `RemoteSpawnCache.java:206–217`: an `IOException`
during cache lookup is reported as a warning and the spawn falls through to
execution. The module `CombinedCacheStore` cites (`CombinedCache.java`,
`downloadActionResultAsync` at 230–280) sits under that policy.

**Status.** Latent: production wires the local tier only today
(`flows/src/NodeRuntime.ts:97`). But the failure mode ships with the
documented composition, and nothing tests it. Decide the policy in the
combined store (remote lookup failure → miss + journalled/metric'd refusal),
not in every caller.

---

## Finding 6 — MEDIUM-LOW: a `decode_failed` head row is a permanent poison; no quarantine path exists for it

**Our code.** A head row whose JSON no longer decodes fails every `get` with
`decode_failed` (`src/CacheStore.ts:285–300`), and the durable test pins that
this blocks the lookup *before* the remote tier and the write-back that would
heal it (`test/CacheStoreDurable.test.ts:194–258` — deliberately, to avoid
masking). But no caller ever evicts on `decode_failed`: the engine's
quarantine (journal + fenced evict, issue #164) runs only for *measured
artifact* corruption after a successful decode
(`ActionPersistence.ts:893–913`). A row-level poison therefore fails the key
on every future dispatch forever — the exact permanent-poison shape issue #164
was raised to eliminate for inline evidence. Mitigation: the schema's
`json_valid` CHECKs (`src/migrations/0001_initial.ts:30–31`) mean this needs
out-of-band corruption; the test constructs it precisely because interrupted
writers and foreign processes can.

**Counterparts.** Bazel treats a corrupt action cache as discardable state:
`CompactPersistentActionCache.java:478–483` moves the corrupt cache aside and
starts fresh. Skyframe routes unexpected node state through
`GraphInconsistencyReceiver` (`GraphInconsistencyReceiver.java:31–39`) and
rebuilds; it never wedges permanently on it.

**Fix shape.** Route `decode_failed` through the `Inconsistency` receiver like
`noteCorruption`, then fenced-evict the undecodable row (fence on the raw
row's provenance columns, which are readable even when the JSON columns are
not). Keep the read itself fail-closed as tested.

---

## Finding 7 — LOW: `get` does not validate the `recordedBy` fence; `evict` does

`validateFence` exists because "a fence naming an empty run or a sequence
number no journal can record … would misreport the caller's mistake as an
ordinary 'nothing matched'" (`src/CacheStore.ts:246–262`). `evict` applies it
(`src/CacheStore.ts:405`); `get` applies nothing to `options.recordedBy`
(`src/CacheStore.ts:316–338`). A malformed fence — empty `runId`, fractional
or negative `eventSeq` — silently degrades to the head, which by Finding 1 is
the silent loss of replay durability rather than a harmless no-op. Same
validation, same reason, one call.

## Finding 8 — LOW (deliberate, recorded as an invariant asymmetry): cross-machine divergence never reaches the `Inconsistency` receiver

A remote `409` means two machines recorded different results under one sealed
key — the distributed form of exactly the hermeticity violation that is
strict-fail locally (`ActionPersistence.ts:708–729`). Both remote paths drop
it: `CacheSync.publishEntry` maps every outcome to `Option.none()`
(`engine-store/src/CacheSync.ts:106–113`, with a comment electing this), and
inline `CombinedCacheStore.put` discards the remote outcome
(`src/CombinedCacheStore.ts:109`). Skyframe's stance is the opposite default:
`GraphInconsistencyReceiver.THROWING` (`GraphInconsistencyReceiver.java:35`),
and this repo quotes that stance for the local tier
(`ActionPersistence.ts:710–712`) and even for selection
(`JournalRecords.ts:283–284`: "note it, never wire the detector to
/dev/null"). The remote conflict is currently wired to /dev/null. It need not
fail the run — but it should at minimum be journalled/metric'd like an
`unpublished` refusal is.

## Finding 9 — LOW: two-tier metrics count a remote hit as a miss

The local SQL tier records `miss` before the combined store consults the
remote tier (`src/CacheStore.ts:343–345`; `src/CombinedCacheStore.ts:74–76`),
and `RemoteCacheStore` records no lookup metrics at all. In the two-tier shape
every remote hit shows up as one `miss` plus write-back `put` counters, so the
advertised hit-rate metric (`src/CacheStoreMetrics.ts:19–41`) under-reports.
Count the outcome at the composition boundary or tag the tier.

---

## Sound areas

- **`put` atomicity and interruption.** Ledger insert, head insert, and the
  conflict re-read run inside one serialized `DurableWriter` transaction
  (`src/CacheStore.ts:359–393`; contract at
  `database/src/DurableWriter.ts:62–72`), so interruption rolls back both
  tables together and the "row disappeared during put" branch is genuinely
  unreachable. Sound.
- **First-writer-wins and fenced eviction.** The CAS rides inside the `DELETE`
  itself (`src/CacheStore.ts:411–420`), closing the cross-process window a
  read-then-delete leaves; the two-connection SQLite tests pin winner
  integrity, torn-row absence, and stale-fence no-ops
  (`test/CacheStoreDurable.test.ts:88–192`). Sound.
- **`ExistingSame`/`Conflict` by canonical result text, meta excluded.**
  Structural value comparison is the right pruning rule
  (`src/CacheStore.ts:200–221, 383–392`; counterpart
  `DirtyBuildingState.java:214–219`), and excluding `meta` is safe because
  reuse-gating declarations (tier, boundary, nondeterminism) are folded into
  the key digest by the caller, per `ActionPersistence.ts:687–694`. Sound
  locally — the remote tier breaks it, see Finding 4.
- **Publication ordering.** Blobs-before-entry is correctly delegated to the
  caller and documented against `UploadManifest.java:630–633`
  (`src/CombinedCacheStore.ts:10–17`); `deferred` mode exists precisely so no
  host call is held across a write transaction. Sound.
- **Dirtying, change pruning, deps, cycles, error bubbling, partial
  re-evaluation.** Not this package's job; its consumers implement the
  Skyframe-side invariants and this store supplies the fenced primitives they
  need. Assessed only where the store's contract leaks into them (Findings
  1–3).

## Summary

The local single-tier store is solid: atomic, serialized, fenced, and
well-tested at the two-connection boundary. The soft spots are all at the
provenance fence's edges — it is the package's version system, and it
currently binds only on the happy path of the local ledger. Findings 1–3 are
the same invariant (a fence must pin bytes or fail visibly) violated in three
places; Finding 4–5 are the remote tier not yet held to the standards the
local tier set; 6–9 are hardening.
