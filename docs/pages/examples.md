# Examples

Nine programs under `examples/src`, each one paired with a test under `examples/test` that runs it against the real packages. Nothing in this directory is mocked: the durable examples open a real SQLite file, the host example spawns a real process, and the browser example is bundled by a real bundler.

```sh
npm install
npm run test:examples
```

The suite is a gate, so a snippet that stops compiling or stops producing the documented answer fails the build rather than drifting quietly.

## The programs

| File | Shows | The assertion that matters |
| --- | --- | --- |
| [`01-define-and-run.ts`](https://github.com/smithersai/flows/blob/main/examples/src/01-define-and-run.ts) | the shortest complete program: `Flow.make`, `toLayer`, `FlowEngine.layerMemory` | the flow returns `Hello, Ada.` |
| [`02-run-durably.ts`](https://github.com/smithersai/flows/blob/main/examples/src/02-run-durably.ts) | the same flow body on `EngineStore` over SQLite, then reading the journal it wrote | the run produces its result and the journal holds lifecycle entries |
| [`03-crash-and-resume.ts`](https://github.com/smithersai/flows/blob/main/examples/src/03-crash-and-resume.ts) | suspending on a `DurableDeferred`, dropping the engine, and resuming from durable state | the handler body runs more than once and the activity in front of the suspension dispatches exactly once |
| [`04-retry-policy.ts`](https://github.com/smithersai/flows/blob/main/examples/src/04-retry-policy.ts) | `RetryPolicy` as inspectable data, and `Activity.retry` as the runtime side | the ladder is `[100, 200, 400, null]`, a non-retryable tag gives up, and the flaky activity succeeds on dispatch three |
| [`05-time-travel-fork.ts`](https://github.com/smithersai/flows/blob/main/examples/src/05-time-travel-fork.ts) | `SqlTimeTravelStore.createFork` copying executable state and attempts into a new run | the fork returns the parent's answer with one total dispatch, because the sealed cache key replays |
| [`06-time-travel-rewind.ts`](https://github.com/smithersai/flows/blob/main/examples/src/06-time-travel-rewind.ts) | `Replay.rederive` folding entries at a frame, and `Rewind.rewind` truncating the suffix | the derived total is the value at the frame, two entries are archived, two remain, and the audit completes |
| [`07-sync-follower.ts`](https://github.com/smithersai/flows/blob/main/examples/src/07-sync-follower.ts) | a follower catching up on durable history and then following live commits | the first two entries are history and the third arrived after the subscription opened |
| [`08-host-adapters.ts`](https://github.com/smithersai/flows/blob/main/examples/src/08-host-adapters.ts) | one adapter-neutral program run on `TestHost` and on `NodeHost` | the scripted shell and the real spawned process both answer |
| [`09-browser-use.ts`](https://github.com/smithersai/flows/blob/main/examples/src/09-browser-use.ts) | importing only browser-safe entry points | the program runs, and esbuild bundles the file with `platform: "browser"` |

## Reading them in order

The first three build on each other. `01` shows what a flow is with nothing durable underneath. `02` swaps `FlowEngine.layerMemory` for the durable engine and changes nothing else in the flow body, which is the point of the encoded seam. `03` is the reason durability exists: the run suspends waiting for an approval that has not arrived, the engine is discarded, a second engine over the same file registers the same handler, and the run finishes without re-dispatching the work it already recorded.

`04` separates policy from execution. The backoff ladder is computed from the policy value with no engine in scope, which is how a deployment can review a retry configuration before shipping it.

`05` and `06` are the two halves of time travel. Fork copies a prefix forward; rewind truncates a suffix away. `06` also shows the read-only side, `Replay.rederive`, which folds committed entries through a reducer and never invokes a handler.

`07`, `08`, and `09` cover the seams around the engine rather than the engine itself: replicating history to a second process, running one program on two host adapters, and staying inside the browser-safe entry points.

## The shared durable layer

`examples/src/durable-layer.ts` composes what `EngineStore.layer` needs: the journal and its three stores, the durable deferred and clock state, a kernel `Jj`, and a `StepBoundary`, all over one SQLite file. Every persistence example reuses it, which is also why a restart in one example reads the rows a previous phase wrote.

The `Jj` in that layer is a stub that records nothing. The examples use sealed activities, so the engine never needs a real snapshot, and a stub keeps the composition honest without requiring a `jj` binary on the machine. No packaged production layer ships yet; assembling this composition is application work today, and that gap is listed in [External](/external).

## Reading next

[Public API](/api/flows) documents every export these programs use. [Public API tests](/api-tests) shows where the same behaviors are pinned inside the packages themselves.
