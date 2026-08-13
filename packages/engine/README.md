# @smthrs/engine-next

The runtime that executes `@smthrs/flow-next` flows, plus the transport
projections that expose them. It implements `FlowRuntime` — the port
`@smthrs/flow-next` declares — over a low-level encoded contract, and ships a
volatile in-memory implementation of it; `@smthrs/engine-store-next` supplies
durable persistence over the same seam.

```sh
npm install @smthrs/engine-next @smthrs/flow-next
```

## Mental model

A `Flow` is the durable program and `Activity` values are its recorded
operations — both defined in `@smthrs/flow-next`. This package is what runs them.

```text
@smthrs/flow-next                    @smthrs/engine-next
  Flow, Activity,   ── port ──▶   FlowEngine
  DurableDeferred,  FlowRuntime   records, suspends, resumes
  DurableClock,                        │
  DurableQueue,                        ▼
  RetryPolicy                    Encoded seam
                                 (in-memory here,
                                  durable in engine-store)
```

| Source               | Role                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FlowEngine/`        | Interprets flows, executes activities, stores outcomes, and resumes suspended executions. `Encoded.ts` is the low-level seam, `make.ts` adapts it to the typed port, `layerMemory.ts` is the in-memory implementation, `FlowInstance.ts` builds per-execution state, and `SnapshotBoundary.ts` is the compensable host hook. |
| `FlowProxy.ts`       | Derives HTTP and RPC definitions for remotely invoking flows.                                                                                                                                                                                                                                                                |
| `FlowProxyServer.ts` | Connects those definitions to the actual flows and engine.                                                                                                                                                                                                                                                                   |
| `index.ts`           | Exposes the public namespaces.                                                                                                                                                                                                                                                                                               |

## Public API

The root exports these namespaces, also available from matching
`@smthrs/engine-next/*` subpaths. The flow-authoring namespaces live in
[`@smthrs/flow-next`](../flow/README.md).

| Namespace         | Public exports                                                                                                                                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FlowEngine`      | Implementation boundary `Encoded` and `ActivityExecuteOptions`; `makeUnsafe`, which adapts an `Encoded` implementation into `@smthrs/flow-next`'s `FlowRuntime`; in-memory `layerMemory`; per-run state constructor `makeInstance`; compensable-step `SnapshotBoundaryOptions` and `SnapshotBoundary`. |
| `FlowProxy`       | `toRpcGroup` / `ConvertRpcs` and `toHttpApiGroup` / `ConvertHttpApi` derive execute, discard, and resume transports from flows.                                                                                                                                                                        |
| `FlowProxyServer` | `layerRpcHandlers`, `layerHttpApi`, and `RpcHandlers` implement the derived transports.                                                                                                                                                                                                                |

## Reference implementation

The walkthrough below exercises the entire public API, namespace by
namespace.

### FlowEngine — the engine contract

```ts
import { FlowEngine } from "@smthrs/engine-next"
import { Effect } from "effect"

// FlowEngine is the service the flow/activity/deferred/clock/queue APIs
// talk to. layerMemory is the in-memory implementation;
// @smthrs/engine-store-next provides the durable one. makeUnsafe builds a
// FlowEngine from an Encoded implementation (the persistence boundary).
const program = Effect.gen(function*() {
  const engine = yield* FlowEngine
  // register, execute, poll, interrupt, interruptUnsafe, resume,
  // activityExecute (ActivityExecuteOptions), deferredResult,
  // deferredDone, scheduleClock
}).pipe(Effect.provide(FlowEngine.layerMemory))

// Per-execution state lives in FlowInstance (FlowInstance.initial builds
// one). Compensable activities need a SnapshotBoundary
// (SnapshotBoundaryOptions) in context. Registering a flow that executes
// itself transitively fails with FlowCycleDetected.
```

### FlowProxy / FlowProxyServer — derived transports

```ts
import { FlowProxy, FlowProxyServer } from "@smthrs/engine-next"
import { Layer } from "effect"
import { HttpApi } from "effect/unstable/http"
import { RpcServer } from "effect/unstable/rpc"

declare const Review: import("@smthrs/engine-next").Flow.Any

// Each flow derives Execute / Discard / Resume endpoints
// (ConvertRpcs / ConvertHttpApi describe the derived types).
const ReviewRpcs = FlowProxy.toRpcGroup([Review], { prefix: "flows_" })
const ReviewApi = HttpApi.make("api").add(
  FlowProxy.toHttpApiGroup("flows", [Review])
)

// FlowProxyServer implements them against the running engine
// (RpcHandlers names the handler set).
const RpcLayer = RpcServer.layer(ReviewRpcs).pipe(
  Layer.provide(FlowProxyServer.layerRpcHandlers([Review], { prefix: "flows_" }))
)
const HttpLayer = FlowProxyServer.layerHttpApi(ReviewApi, "flows", [Review])
```
