# Review: `@smthrs/keys` vs Bazel Skyframe

Date: 2026-08-19. Scope: `flows/packages/keys` (source and tests), compared against
`reference/bazel/src/main/java/com/google/devtools/build/skyframe`.

## Scope note

`@smthrs/keys` is deliberately a leaf: one schema, `Key`, that turns a canonical JSON
value into `key1_<sha256>` (`keys/src/Key.ts:60-75`). It is the SkyKey-identity layer
of the system, not the evaluator. Of the evaluator invariants named for this review,
none is implemented in this package, and each has a Skyframe counterpart the `engine`
review should be held against instead:

- Node dirtying and change pruning: `DirtyBuildingState.java`.
- Graph/evaluation versions: `Version.java`, `IntVersion.java`, `NodeVersion.java`.
- Error bubbling and transitive error propagation: `ErrorInfo.java`, `AbstractParallelEvaluator.java`.
- Cycle detection: `CycleDetector.java`, `SimpleCycleDetector.java`.
- Dependency bookkeeping and invalidation: `GroupedDeps.java`, `ReverseDepsUtility.java`, `InvalidatingNodeVisitor.java`.
- Partial re-evaluation: `PartialReevaluationMailbox.java`.
- Interruption: `SchedulerException.java`, `NodeEntryVisitor.java`.

Those areas are out of scope here because they live in `packages/engine` and
`packages/engine-store`. This report covers the invariants `keys` does own: key
identity, namespace separation, scheme versioning, and memoization-reuse correctness
of the digest itself. Where a finding needs call-site evidence, it cites the
consumers (`plan`, `engine`, `engine-store`, `flow`) that mint keys through this
package.

## Findings, ranked

### 1. Medium (design gap): the key primitive carries no function-identity namespace, and untagged minting sites already exist

Skyframe's core identity invariant is that a key is a pair. `SkyKey.java:25` states it
directly: "A SkyKey is effectively a pair (type, name)". The type half is structural:
`SkyKey.functionName()` is an abstract method (`SkyKey.java:42`), it participates in
`equals`/`hashCode` (`AbstractSkyKey.java:39-41`, `54-55`), and the names themselves
come from a checked interned registry. `SkyFunctionName.java:61-69` runs a
`Preconditions.checkState` on every registration, so two subsystems that pick the same
name with different semantics fail loudly at construction time. Cross-function
collision is impossible by construction.

Our `Key` decodes `Schema.Unknown` with no required namespace field
(`keys/src/Key.ts:60-62`). Namespace separation is a convention that each consumer
implements by hand-picking a `kind` string. The current census:

| Package | Site | Tag |
| --- | --- | --- |
| plan | `plan/src/StepKey.ts:302, 321, 492` | `content`, `ordinal`, `input-value` |
| engine | `engine/src/FlowEngine/ActionKey.ts:171-172` | `run`, `cache` |
| flow | `flow/src/Action/StepIdentity.ts:134, 160` | `declaration`, `invocation` |
| engine-store | `engine-store/src/StepBoundary.ts:845, 870-871` | `tree-artifact`, `diff-identity` |
| engine-store | `engine-store/src/internal/ActionPersistence.ts:614-615` | `cache-generation` |
| flow | `flow/src/Interpreter.ts:155-161` | none (raw payload, then a bare 4-element array) |
| flow | `flow/src/Flow/ExecutionIds.ts:64-65` | none (raw encoded payload) |

Two facts follow from that table:

- The tag vocabulary is spread across four packages with no registry, no shared
  constant module, and no test that asserts the strings are pairwise distinct or that
  a given tag always fronts the same material shape. Today they happen to be
  distinct. Nothing keeps them distinct; the next call site that picks `content` or
  `cache` for a different shape creates silent aliasing in whichever store both keys
  reach, and the symptom is a stale hit, not a failure.
- Two sites mint keys with no tag at all. I traced both and neither digest currently
  reaches a `key1_`-keyed store: `Interpreter.ts:155-156` produces intermediates that
  are folded into a child execution id and stripped of the prefix
  (`Interpreter.ts:162`), and `ExecutionIds.ts:64-65` feeds a second bare-hex
  derivation (`ExecutionIds.ts:84`). So this is a missing invariant, not an active
  collision. But the safety argument is "I inspected every call site and the
  untagged digests stay intermediate", which is exactly the kind of argument
  Skyframe's design makes unnecessary.

Recommendation: give the package the structural half of the SkyKey pair. Export a
tagged constructor (for example a `Key.namespaced(kind)` schema factory that folds a
declared kind into the hashed document), keep the raw `Key` decode internal or
test-only, and add one repo-level test that greps for `decodeUnknownEffect(Key)`
outside the sanctioned wrapper, plus one that registers every kind string in a single
table the way `SkyFunctionName`'s interner does.

### 2. Medium-low (bug in the stated contract): the version marker promises forward decodability the pattern cannot deliver, and accepts never-minted versions today

The docblock says a future derivation gets `key2_` "and both remain decodable, so a
stored key never becomes ambiguous" (`keys/src/Key.ts:12-14`), and the pattern
comment repeats that a pattern anchored to one version "would refuse exactly the keys
the marker promises to keep decodable" (`keys/src/Key.ts:27-31`). The test at
`keys/test/Key.test.ts:136-143` enshrines the promise.

The pattern is `/^key[1-9][0-9]*_[0-9a-f]{64}$/` (`keys/src/Key.ts:36`). It accepts
any version number but pins every version to exactly 64 lowercase hex characters,
which is to say: to SHA-256's shape. The most likely reason a `key2_` scheme would
ever exist is a digest change (truncation, SHA-512, BLAKE3), and any such scheme
produces keys this validator refuses. The pattern keeps the promise only for future
schemes that change the derivation without changing the digest width and alphabet,
which is the least likely kind of future scheme.

The converse problem is worse in the present: `key2_<any 64 hex>` validates today
even though no scheme has ever minted a `key2_` value. The neighbouring test justifies
rejecting `key0_` on exactly the ground that it is "not [a version] the scheme has
ever minted, so accepting [it] would let a corrupted value masquerade as a key"
(`keys/test/Key.test.ts:145-152`). That reasoning applies verbatim to `key2_` through
`key999..._`. The two tests encode contradictory policies and both pass.

Skyframe has no analog of a self-describing serialized key string, and that is
instructive: version tolerance there is handled by explicit version objects the
evaluator compares (`Version.java`, `IntVersion.java`, `NodeVersion.java`), never by
accepting an unknown future form and hoping it stays well-shaped. Recommendation:
validate only versions the code can interpret (today, `key1_` exactly), and let the
storage-reading edge classify unknown markers explicitly (readable-but-foreign versus
corrupt) when a second scheme actually ships. Delete or invert the
`key2_`-acceptance test when doing so.

### 3. Low (API gap): the validated storage codec is effectively unreachable, so stores fall back to unvalidated strings

`KeyValue`, the pattern-checked branded string, is `@private`
(`keys/src/Key.ts:25-38`). The only exported symbol is the one-way derivation. A
consumer that wants to validate a key it read from storage must know to write
`Schema.toType(Key)`, and the only call sites of that incantation in the tree are this
package's own tests (`keys/test/Key.test.ts:25, 142`). Production stores type key
columns as plain strings instead: `engine-store/src/PlanScheduler.ts:341` persists
`stepKeyDigest: Schema.NonEmptyString`. That defeats the invariant `@smthrs/crypto`
states for digests, that an identity "crosses the journal and the cache and must
compare byte-for-byte wherever it is read" (`crypto/src/Sha256.ts:9-11`): a corrupted
or truncated key column round-trips unnoticed until it simply never matches.

There is also a misuse footgun in the same gap: the exported direction, decode, is
total on strings, so "validating" a stored key by decoding it silently re-hashes the
key string into a different, perfectly well-formed key. No call site does this today;
nothing but convention prevents it. Skyframe does not have the hazard because keys
are typed objects end-to-end and re-wrapping is an explicit, documented act
(`AbstractSkyKey.java:20-22` covers even the key-inside-key case).

Recommendation: export the validated string schema (for example `Key.FromStored` or
`Key.Schema`) and use it in store row schemas; document that decode derives and never
validates.

## Areas checked and found sound

- Canonicalization is RFC 8785-correct where key identity depends on it: member sort
  by UTF-16 code units (`canonical/src/internal/canonicalize.ts:72`), ECMAScript
  number serialization (`canonicalize.ts:56`), lone-surrogate refusal at the one point
  that sees every emitted string including `toJSON` output (`canonicalize.ts:28-42`),
  cycle refusal (`canonicalize.ts:57-59`), and a fail-closed `JSON.parse` backstop
  that turns any serializer gap into a decode failure rather than a divergent digest
  (`canonical/src/Canonical.ts:67`).
- The deliberate erasures (`-0` to `0`, dropped `undefined` members, `undefined`
  array elements to `null`) are documented as contract and pinned by tests
  (`keys/test/Key.test.ts:80-102`), and the property test asserts injectivity exactly
  up to canonical equality (`keys/test/Key.property.test.ts:45-86`). This is the
  right collision contract for a content key.
- Injection resistance holds: structure is inside the digest, and the classic
  concatenation witnesses are tested (`keys/test/Key.test.ts:104-118`). The one
  concatenation-based derivation in a consumer (`flow/src/Flow/ExecutionIds.ts:84`,
  `` `${flow._tag}-${key}` ``) is injective only because the suffix is a fixed-shape
  key string; it would be more robust folded through `Key`, but it is outside this
  package and not currently a collision.
- Cross-release key stability is golden-pinned (`testing/test/KeyGoldens.test.ts:11-13`),
  which is the correct guard for cache identity across refactors.
- The digest-not-argument design is coherent. A Skyframe key must carry its preimage
  because a dirtied node re-runs from `SkyKey.argument()` (`SkyKey.java:44-46`); a
  `Key` can address work but never re-produce it. The system accounts for this: plan
  materials are retained above the key (`plan/src/KeyMaterial.ts`,
  `plan/src/StepKey.ts:337-379`), so the engine dispatches from material and uses
  keys purely as addresses. The invariant to protect going forward is that no engine
  path ever needs to enumerate, dirty, or re-evaluate from a bare `Key`; if one
  appears, it needs a key-to-material side table by design, not by accident.
