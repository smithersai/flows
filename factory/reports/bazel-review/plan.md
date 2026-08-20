# `@smthrs/plan` vs Bazel Skyframe: review findings

Reviewed: `flows/packages/plan/src/**` and its tests, against
`reference/bazel/src/main/java/com/google/devtools/build/skyframe` (and
`lib/util/Fingerprint.java`, `lib/actions/ActionKeyContext.java` where the
invariant lives outside the skyframe directory).

Context for calibration: this package deliberately replaces Skyframe's
dirty-node machinery with content addressing. Invalidation is re-keying
(`Plan.ts:7-15`), change pruning is the two-level plan-key/dispatch-key split
(`StepKey.ts:433-448`), and there is no evaluator here; scheduling, error
bubbling, and partial re-evaluation live in `@smthrs/engine-store`. The
findings below are places where that substitution leaks, or where this
package's own invariants are stated but not held.

Findings are ranked by severity.

---

## 1. HIGH — Hermetic write-set canonical order uses `localeCompare`; key determinism depends on the host locale

`StepKey.ts:279-280`:

```ts
const writeSet = [...new Map(normalizedWrites.map((entry) => [JSON.stringify(entry), entry])).values()]
  .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
```

`String.prototype.localeCompare` with no locale argument collates under the
host's default ICU locale. The sorted `writeSet` is an array, and RFC 8785
canonical JSON preserves array order, so the sort order enters the digest.
Two machines with different locales (or different ICU builds) can hash the
same hermetic declaration to two different keys. This is not limited to
non-ASCII: en-style collation orders `"a" < "Z"` while code-point order gives
`"Z" < "a"`, so any mixed-case multi-entry write set is at risk. Consequences:
cross-machine cache misses for identical steps, and, worse, an approval digest
(`digestOf` covers `effects`, and dispatch keys fold `hermetic`) that does not
reproduce on another machine.

Everything else in this file sorts deterministically: `sortStrings`
(`StepKey.ts:232-233`) uses default code-unit sort, and the `readSet`
comparator (`StepKey.ts:263-265`) uses explicit `<`. Only `writeSet` uses
locale collation. The existing tests cannot catch this: the two pinned exact
digests (`StepKey.test.ts:230`, `:341`) use single-entry write sets, and the
multi-entry normalization test only asserts left === right under one locale.

Skyframe counterpart: `lib/util/Fingerprint.java:275` (map fingerprinting
requires "a deterministic iteration order"); action keys are built from
deterministic byte sequences via `ActionKeyContext`. Nothing in Bazel's
fingerprint path consults locale.

Fix: sort by code units (`left < right ? -1 : ...` on the JSON strings),
matching the `readSet` comparator.

## 2. HIGH — `append` leaves a frozen-reader / new-writer pair unordered and unannotated

The reader-after-writer pass exists because a reader admitted in the same
wavefront as its producer "measures pre-producer bytes and — because the
dispatch key honestly folds the digest it measured — caches that wrong
execution as a legitimate one"; the pass "is what makes the assumption
[`PlanScheduler.measure`'s "their producer has settled"] true"
(`Plan.ts:399-406`). But the pass skips frozen readers entirely
(`Plan.ts:430-431`), and the conflict pass cannot see reader/writer pairs at
all (`Plan.ts:267-271`). So when an elaboration appends a writer for a path a
not-yet-dispatched generation-0 node reads, the pair ends up with:

- no ordering edge in either direction, and
- no conflict annotation on either side (reader/writer pairs are "not a
  conflict", and the frozen row could not carry one anyway).

The behavior is pinned by `test/Plan.test.ts:358-366` ("lands a
reader-after-writer edge on the new node only"): the late writer's
`dependsOn` is asserted `[]`. The test documents the append-only constraint
but not the consequence: the run's outcome now depends on scheduler timing.
If the frozen reader dispatches first it reads pre-writer bytes; if the
writer wins it reads post-writer bytes. Both cache entries are honest, but
the run is no longer deterministic under replay, and the invariant the pass
was written to restore is unenforced again after every elaboration.

Note the asymmetry: for a frozen writer / new reader, the edge lands on the
new reader and all is well (`test/Plan.test.ts:367-372`). For the frozen
reader, an edge is representable without rewriting the frozen row: order the
new writer BEHIND the frozen reader (`late-writer.dependsOn =
["recorded-reader"]`). That is also the semantically right order: the frozen
reader was approved against a plan in which the writer did not exist, so it
should observe pre-writer state. The pass already computes reachability in
both directions (`Plan.ts:437-444`); it just never considers the frozen-reader
case.

Skyframe counterpart: this is exactly the hole its version machinery closes.
When an input changes, `InvalidatingNodeVisitor.java:51-59` dirties the
reverse transitive closure, and `DirtyBuildingState.java:189-190` compares
`childVersion` against `lastEvaluated` so a reader can never consume a dep
state the graph version does not account for. flows rejected reverse deps
because re-keying subsumes them (`Plan.ts:11-15`) — but a frozen node can
never re-key, so for frozen nodes NEITHER mechanism applies. Ordering is the
only remaining tool, and this pass declines to use it.

If `PlanScheduler` independently guards this (e.g. refuses to dispatch a new
writer while an unsettled earlier-generation reader overlaps it), document
that here; nothing in this package or its tests says so.

## 3. MEDIUM — Conflict pass uses a stale transitive closure; serialize edges are not folded through, producing spurious conflicts and spurious `fail` refusals

`annotate` computes the dependency closure once, up front, from material
edges (`Plan.ts:367`, `reachable` at `Plan.ts:327-339`, which copies sets, so
no aliasing). When a `serialize` verdict adds an ordering edge it patches only
the direct entry: `closure.get(later.id)!.add(earlier.id)` (`Plan.ts:395`).
Nodes whose closure was derived from `later` before the patch never see it.

Concrete failure, all in one compile, plan order A, B, C:

- A writes `x`; B writes `x` (no deps); C writes `x`, material dep on B.
- Pair (A,B): overlap, serialize edge B→A, `closure(B)` gains A.
- `closure(C)` was computed from `closure(B)` before the patch, so it is
  `{B}` — missing A.
- Pair (A,C): `closure.get("C").has("A")` is false, so the pair is treated as
  unordered even though the final graph orders C→B→A. Result: a spurious
  conflict annotation on both A and C, a redundant direct edge C→A, and — if
  C declares `conflictStrategy: "fail"` — a `overlap_forbidden` refusal of a
  plan that is in fact fully ordered.

This violates the module's own rule, stated at `Plan.ts:350-351`: "Nodes
already ordered by a dependency path are not conflicts." The spurious
annotations also enter the plan digest (`digestOf` covers `conflicts` and
`dependsOn`, `Plan.ts:475-483`), so plans that should hash identically do not.

The second pass in the same function already got this right: it computes
reachability live over the growing edge set (`reaches`, `Plan.ts:415-427`).
The fix is to make pass one consistent with pass two: either maintain the
closure incrementally in plan order inside the pair loop (serialize edges only
point backward, so plan-order accumulation is sound), or reuse `reaches`.

Skyframe has no direct counterpart (conflicts are a Bazel actions concern,
`ArtifactConflictFinder`), but the invariant "consult the graph as it exists
now, not a snapshot" is the same one `GraphTraversingHelper`-style checks
follow everywhere in the evaluator.

## 4. MEDIUM — `topological` recurses; a deep plan overflows the native stack and escapes as a defect instead of a `PlanError`

`Plan.ts:293-313`: `visit` calls itself per material dependency, so recursion
depth equals the longest dependency chain. A chain-shaped plan of a few
thousand nodes throws `RangeError: Maximum call stack size exceeded`, which
surfaces through `Effect.gen` as a defect (die), not as the typed
`PlanError` the signature promises. Cycle detection is exactly the code that
must survive adversarial graph shapes.

Skyframe pins this invariant explicitly: `SimpleCycleDetector.java:102-104`
— "Maintain a stack explicitly instead of recursion to avoid stack
overflows". This package already follows that rule twice, for exactly this
stated reason: the payload cloner (`internal/node.ts:373-379`, "the walk
carries its own explicit stack rather than recursing, because a payload's
nesting depth ... must not be bounded by the native call stack") and
`reaches` (`Plan.ts:416-427`). `topological` is the odd one out.

Related, lower severity: the cycle error names one node ("Plan cycle through
node X", `Plan.ts:296`) with no cycle path. Skyframe reports the full cycle
and the path to it (`CycleInfo.java:33-47`, `getCycle` /
`createCycleInfo(pathToCycle, cycle)`), which is what makes a cycle in a
compiled, id-rewritten graph debuggable. An explicit-stack rewrite gets the
path for free.

## 5. MEDIUM — `DigestMemo` is poisoned by interruption and caches failures forever

`StepKey.ts:171-186`: the first caller for a `[from, path]` address installs a
`Deferred` and completes it with whatever exit `compute` produces
(`Effect.onExit((exit) => Deferred.done(pending, exit))`). Two problems:

- **Interruption poisons the entry permanently.** If the first computing
  fiber is interrupted (a sibling dispatch failed and the scheduler tore down
  the wavefront's scope — the normal Effect cancellation path this repo
  mandates), the deferred is completed with the interrupt exit. A completed
  deferred never un-completes, and entries are never removed, so every later
  `digest()` call for that address awaits the poisoned deferred and is itself
  interrupted (`reference/effect/packages/effect/src/Deferred.ts:604`:
  "Fibers waiting on the Deferred are interrupted"). A retried node that
  shares the memo can never compute its dispatch key again.
- **Failures are memoized with no transience distinction.** A failed
  `compute` exit is cached and replayed to every subsequent caller. For a
  deterministic `SchemaError` this is arguably correct, but the memo has no
  way to distinguish a transient failure, and no eviction.

Skyframe holds both invariants explicitly: an interrupted evaluation leaves
in-flight nodes cleaned so the next evaluation restarts them
(`DirtyAndInflightTrackingProgressReceiver.java:102-112` — enqueued nodes
"will be either verified clean, re-evaluated, or cleaned up ... or
interrupt"), and transient errors depend on `ErrorTransienceValue`, which "is
not equal to anything, including itself, in order to force re-evaluation"
(`ErrorTransienceValue.java:18-21`). The memo needs the standard fix Effect's
own caches use: on a non-success exit (at minimum on interruption), delete the
entry instead of completing the deferred, so the next caller recomputes.

## 6. LOW — `PlanDiff.changedFields` omits `placement` and `nondeterministic`, misattributing those re-keys as pure upstream effects

The dispatch body folds `nondeterministic`, `effects`, and `placement`
(`StepKey.ts:388-394`), and the tests pin that each moves the key
(`StepKey.test.ts` "folds effects, placement, and the material version...",
"folds declared nondeterminism..."). But the attribution comparator checks
only body, layers, capabilities, effects, version, and inputs
(`PlanDiff.ts:71-88`). A node re-keyed by a `placement` or `nondeterministic`
edit reports `changed: []` — which the module documents as meaning "re-keyed
purely by an upstream edit whose reference is a Pending with no projection"
(`PlanDiff.ts:31-35`). The report is not just incomplete; it points the human
at the wrong cause. Secondary: `capabilities` and `layers` are compared
order-sensitively while the key normalizes them as sets, so a re-keyed node
whose capability list was merely reordered gets a spurious `"capabilities"`
label. Attribution is human-facing only, so no cache impact.

## 7. LOW — Two documented key-soundness invariants are not enforced in code

- **`nondeterministic: true` changes the digest but nothing refuses reuse.**
  `KeyMaterial.ts:66-67` declares the flag; `fromKeyMaterial` and
  `dispatchIdentity` fold it and mint an ordinary cross-run `content` key. If
  the scheduler does not special-case it, a declared-nondeterministic step
  gets cached and never re-executes — the flag becomes a pure hash
  perturbation. Skyframe treats this as a first-class node property:
  `FunctionHermeticity.java:46-50` (`NONHERMETIC`: "expected to routinely
  produce different results even if its dependencies are unchanged") relaxes
  version-based pruning for such nodes. If enforcement lives in
  `engine-store`, this package should say so where the flag is declared;
  today no consumer of the flag exists outside the hash.
- **`runScope` "is set only when `declared` is `false`" (`StepKey.ts:130-133`)
  is not validated.** `content` accepts `declared: false` with no `runScope`
  and happily mints a cross-run-reusable key for a step whose environment
  identity is unknown — the exact stale-hit vector the docstring warns
  against. One `if` in `content` (or a refinement on `EnvironmentIdentity`)
  closes it. Skyframe's style here is `checkState` at every lifecycle
  transition (`DirtyBuildingState.java:142-148`); invariants that matter are
  asserted, not narrated.

## 8. LOW — `overlaps(Glob, Glob)` and `overlaps(TreeArtifact, Glob)` are constant `true`; under a `fail` strategy the over-approximation becomes a spurious compile refusal

`FileSet.ts:254` and `:260`. The conservatism is documented ("`true` may
over-serialize", `FileSet.ts:238`) and is harmless for `serialize`, but
`pairStrategy` promotes any overlap to a hard `overlap_forbidden` error when
either side declared `fail` (`Plan.ts:228-229`, `:380-387`). A flow that
promises disjointness and declares two obviously disjoint globs
(`src/**` vs `docs/**`) cannot compile. A cheap literal-prefix comparison of
the include patterns (both are workspace-relative, `..`-free, `.`-free by the
`Pattern` schema) would prove disjointness for the common cases. Bazel proves
actual output conflicts from concrete artifact paths rather than refusing on
pattern kind alone.

## 9. LOW — `project` reads inherited properties, so a projection onto a built-in name fails at dispatch instead of hashing as absent

`StepKey.ts:423-430` documents "a segment that does not exist yields
`undefined`, which is a stable, distinct value ... a fact about the graph,
not a failure". But the walk uses bare indexing, so
`project({}, ["toString"])` returns the inherited
`Function.prototype.toString`, and `decodeKey({kind: "input-value", value})`
then fails canonicalization with a `SchemaError` at dispatch time. The
`Planned` proxy refuses `toString`/`valueOf`/`toJSON` accesses
(`Planned.ts:93-98`) but records `constructor`, `hasOwnProperty`, and
`__proto__` as ordinary path segments, so such paths are reachable from
authored flows. `Object.hasOwn` before the read makes the implementation
match its documentation. This is the exported "ONE projection semantics for
the value channel" (`StepKey.ts:415-421`), so any consumer that reimplements
it with own-property semantics would diverge from the key — fix here, once.

---

## Minor notes (no action required individually)

- `PlanStore.append` is not idempotent: a byte-identical re-append fails on
  the node primary key instead of returning an `ExistingSame`-style outcome,
  unlike `record` (`PlanStore.ts:69-73`, `:190-215`). A crash between commit
  and the caller observing it forces manual reconciliation.
- `flows_plan_nodes.ordinal` has no uniqueness constraint
  (`migrations/0001_initial.ts:44-53`); a stale in-memory plan appended by a
  second writer that dodges the generation trigger could produce duplicate
  ordinals and nondeterministic `get` order. `UNIQUE (plan_id, ordinal)` is
  free insurance.
- `internal/node.ts:220-221` reads `globalThis.crypto.getRandomValues` at
  module load, outside any Layer. It is browser-safe, but the repo's own rule
  is "host access goes through a Layer, always — ... random, crypto"; if this
  is a deliberate exception it should carry a ticket per Tickets Not
  Exceptions.
- `branchOrdinal`/`catchOrdinal` (`Node.ts:144`, `:159`) make subject tokens
  process-history-dependent. I verified they never reach key material (flow's
  `Graph.build` substitutes them before material derivation, `Graph.ts:989`,
  `:1021`, and branch/catch bodies carry only tag+predicate/filter,
  `Graph.ts:1006`, `:1041`), so keys are unaffected; but serialized ASTs of
  identical flows differ across processes, which will make AST-level diffing
  or snapshotting noisy.
- The reader-after-writer pass is O(N² · E) (a fresh DFS per pair,
  `Plan.ts:428-447`). Fine at current plan sizes; will need a transitive
  bitset or memoized reachability if plans grow past a few hundred nodes.

## Areas checked and found sound

- **Change pruning / early cutoff**: the plan-key vs dispatch-key split
  (`StepKey.ts:433-448`) is a faithful counterpart of Skyframe's
  `signalDep`/`childChanged` pruning (`DirtyBuildingState.java:189-198`) moved
  into content space, and the value-channel cutoff is well pinned
  (`StepKey.test.ts` "folds the settled output value of a Ref, never the
  upstream's identity").
- **Version handling**: the material version constant folded into every body
  (`KeyMaterial.ts:51`), versioned `FunctionIdentity` algorithm tags
  (`internal/node.ts:204`), and the `key1_` prefix give every digest an
  evolvable namespace; no graph/evaluation version is needed because keys are
  content-addressed. Sound.
- **Key collision hardening**: the nominal `DigestInput` brand, per-variant
  reference tagging, the separate environment namespace, and
  absent-vs-empty distinctions are thorough and each is pinned by a D7 test.
  Sound.
- **Dependency bookkeeping**: edges and hashed references derive from one
  function (`KeyMaterial.dependencies`, `KeyMaterial.ts:93-99`), so they
  cannot disagree; ordering edges are deliberately excluded from keys with
  the cache-hit rationale tested (`Plan.test.ts` "serializes overlapping
  writers ... without re-keying them"). Sound.
- **Error bubbling / transitive error propagation / partial re-evaluation /
  interruption of evaluation**: not in this package by design; the plan is
  inert and the halt rule ("a dependent of failed or skipped work never
  dispatches", `StepKey.ts:452-454`) is a scheduler contract this package
  only documents. Verify in `engine-store`, not here.
- **Append-only persistence**: trigger-enforced immutability plus the
  forward-only generation/base-digest trigger
  (`migrations/0001_initial.ts:64-78`) and the transactional
  append-to-unrecorded-plan refusal (`PlanStore.ts:201-212`) are solid.
- **The hand-rolled SHA-256** (`internal/sha256.ts`): padding, block-count,
  and 64-bit length encoding verified correct by inspection, including the
  56-63-byte tail cases.
