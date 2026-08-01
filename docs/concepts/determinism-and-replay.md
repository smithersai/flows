# Determinism and replay

This page defines the replay contract for flow authors and engine implementers. It covers current handler re-execution, activity memoization, suspension, and the distinction between engine replay and time-travel projection.

## The replay function

Conceptually, a handler should behave like:

```text
result = handler(encoded payload, recorded durable boundaries)
```

On resume, the durable engine:

1. claims the run;
2. decodes the original payload;
3. starts the registered handler from the top;
4. returns stored attempts and deferred completions at known boundaries;
5. dispatches at the first boundary with no recorded result.

Control flow is re-evaluated. It is not restored from a JavaScript stack snapshot.

## Deterministic flow code

Code between durable boundaries must produce the same control flow when given the same payload and recorded values. Do not use:

- `Date.now()` or a process clock directly;
- `Math.random()` or unseeded random values;
- global mutable state;
- unordered external reads;
- changing environment variables;
- Host operations outside an `Activity`.

Instead, run nondeterministic or effectful work inside a recorded activity:

```ts
const ReadConfig = Activity.make({
  name: "config/read",
  success: Schema.String,
  tier: "sealed",
  idempotencyKey: {
    body: "config/read/v1",
    inputs: { path: "/workspace/config.json" },
    layers: ["node-file-system"],
    capabilities: { declared: ["fs:read:/workspace/config.json"] }
  },
  execute: readConfigEffect
})
```

The output may be nondeterministic. Replay safety comes from recording its encoded exit, not from requiring the output itself to be predictable.

## Activity identity

For a sealed activity with an `idempotencyKey`, the flow engine computes a content key. A **string** `idempotencyKey` is namespaced by the activity `name` (mirroring Skyframe's `SkyKey = (functionName, argument)`), so two distinct activities that pick the same idempotency string never share a key or replay each other's outcomes. This means renaming an activity that uses a string key changes its identity. An **object-form** `ContentIdentity` is caller-owned: the `name` is not folded in, so it is the escape hatch for rename-stable identity. String-key digests persisted before this namespacing do not replay against the new keys; those rows were unsafe (cross-activity aliasing), so the break is intentional.

Sealed activities without a content identity, plus compensable and irreversible activities, use an ordinal allocated from a counter scoped to the activity's name, with the name folded into the key (issue #73). Concurrent activities of different names are therefore stable under any interleaving. Repeated invocations of one activity are numbered in allocation order, so changing control flow before such a boundary can still change which invocation occupies which ordinal. Prefer stable content identities for replayable reads.

## Suspension

When a durable deferred has no stored exit, `DurableDeferred.await` marks the flow suspended and interrupts the current flow fiber. `Flow.intoResult` converts the suspension interrupt into a `Flow.Suspended` value. The durable driver stores `suspended` and releases ownership.

Completing the deferred persists its first result, records and flushes a journal event, then schedules a claim-gated wake. Re-execution reads the completion and proceeds.

## Races

`DurableDeferred.raceAll` checks for an already persisted winner before running a new `Effect.raceAll`. The first exit is written to a named deferred, so replay returns that exit instead of choosing again from new timing.

The current public API does not expose a separate durable record for every losing branch. Do not assume loser outcomes are individually replayable.

## Replay versus time-travel projection

Two APIs use “replay” differently:

- `EngineStore` replay re-runs a registered flow handler and returns stored boundaries.
- `TimeTravel.Replay.rederive` is read-only. It folds committed journal entries up to a `Frame` and optionally resolves cache values. It never invokes a flow handler or activity dispatcher.

The latter is suitable for rebuilding a view or assessing a frame. It is not an engine resume.

## Source changes

There is no flow-source digest check. Existing activity keys and ordinal positions determine what reuses recorded state after a code edit:

- changed content identity → new activity result;
- unchanged content identity → existing result;
- changed control flow around ordinal activities → potentially different ordinal mapping;
- changed flow schemas → stored payload or result decoding may fail as a defect.

Version flow tags, activity bodies, and schemas deliberately when compatibility changes.

## Related

- [Durable execution model](durable-execution-model.md)
- [Step keys](step-keys.md)
- [Time travel](time-travel.md)
- [Testing](../guides/testing.md)
