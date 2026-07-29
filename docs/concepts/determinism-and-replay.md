# Determinism and replay

This page defines the replay contract for workflow authors and engine implementers. It covers current handler re-execution, activity memoization, suspension, and the distinction between engine replay and time-travel projection.

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

## Deterministic workflow code

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

For a sealed activity with an `idempotencyKey`, the workflow engine computes a content key. The activity’s display `name` is not part of that key. Renaming an activity while keeping the same content identity reuses the same result.

Sealed activities without a content identity, plus compensable and irreversible activities, use an ordinal allocated by traversal order within the execution. Changing control flow before an ordinal boundary can therefore change which operation occupies that ordinal. Prefer stable content identities for replayable reads.

## Suspension

When a durable deferred has no stored exit, `DurableDeferred.await` marks the workflow suspended and interrupts the current workflow fiber. `Workflow.intoResult` converts the suspension interrupt into a `Workflow.Suspended` value. The durable driver stores `suspended` and releases ownership.

Completing the deferred persists its first result, records and flushes a journal event, then schedules a claim-gated wake. Re-execution reads the completion and proceeds.

## Races

`DurableDeferred.raceAll` checks for an already persisted winner before running a new `Effect.raceAll`. The first exit is written to a named deferred, so replay returns that exit instead of choosing again from new timing.

The current public API does not expose a separate durable record for every losing branch. Do not assume loser outcomes are individually replayable.

## Replay versus time-travel projection

Two APIs use “replay” differently:

- `EngineStore` replay re-runs a registered workflow handler and returns stored boundaries.
- `TimeTravel.Replay.rederive` is read-only. It folds committed journal entries up to a `Frame` and optionally resolves cache values. It never invokes a workflow handler or activity dispatcher.

The latter is suitable for rebuilding a view or assessing a frame. It is not an engine resume.

## Source changes

There is no workflow-source digest check. Existing activity keys and ordinal positions determine what reuses recorded state after a code edit:

- changed content identity → new activity result;
- unchanged content identity → existing result;
- changed control flow around ordinal activities → potentially different ordinal mapping;
- changed workflow schemas → stored payload or result decoding may fail as a defect.

Version workflow tags, activity bodies, and schemas deliberately when compatibility changes.

## Related

- [Durable execution model](durable-execution-model.md)
- [Step keys](step-keys.md)
- [Time travel](time-travel.md)
- [Testing](../guides/testing.md)
