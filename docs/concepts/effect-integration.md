# Effect integration and error taxonomy

This page explains how Smithers Flows uses Effect services, layers, schemas, typed failures, defects, and infrastructure interruption. It covers the execution engine’s error model, not application-specific error design.

## Effects are the dependency graph

Flow handlers and activities are ordinary `Effect` programs. Required services remain visible in the environment type, and `Layer` values select implementations at the application boundary:

```ts
import { Activity } from "@smthrs/flow-next"
import { Context, Effect, Schema } from "effect"

interface SourceFiles {
  readonly read: (path: string) => Effect.Effect<string>
}

const SourceFiles: Context.Service<SourceFiles, SourceFiles> =
  Context.Service("example/SourceFiles")

const ReadSource = Activity.make({
  name: "ReadSource",
  success: Schema.String,
  execute: Effect.flatMap(SourceFiles, (files) => files.read("src/main.ts"))
})
```

The `SourceFiles` requirement is part of the activity’s type. It is supplied when the flow handler layer is assembled; it is not recovered from a global registry.

## Schemas define durable values

`Flow.make`, `Activity.make`, and `DurableDeferred.make` take Effect schemas. The engine encodes payloads, successes, and expected errors before placing them in durable storage. A value that cannot be encoded is a composition or schema defect, not a replayable application result.

Prefer small, explicit schemas whose encoded representation can remain compatible across deployments. Changing an activity name or encoded schema can invalidate replay assumptions even when TypeScript still compiles.

## Failure categories

The runtime distinguishes these cases:

| Category | Representation | Durable behavior |
| --- | --- | --- |
| Expected application failure | Activity or flow error schema | Encoded in `Exit` and returned on replay |
| Defect | Effect cause outside the error channel | Captured or allowed to die according to `Flow.CaptureDefects` |
| Infrastructure interruption | `Activity.InfraInterrupt` | Retried only when the activity declares `interruptRetryPolicy` |
| Suspension | `Flow.Suspended` result | Releases ownership and leaves the run resumable |
| Composition failure | `EngineStore.EngineCompositionError` | Indicates missing or incompatible engine services |
| Permission denial | `Permission.PermissionError`, or `PlatformError` carrying it | `Jj` and `HttpClient` fail with the typed kernel failure directly; Effect-owned tags (`FileSystem`, `ChildProcessSpawner`) surface a `PlatformError` with reason `PermissionDenied` whose `cause` is recovered via `Permission.fromPlatformError` |

`Activity.InfraInterrupt` is deliberately narrower than cancellation. An exhausted infrastructure retry schedule becomes a defect:

```ts
import { Activity } from "@smthrs/flow-next"
import { Effect, Schedule, Schema } from "effect"

const FetchInput = Activity.make({
  name: "FetchInput",
  success: Schema.String,
  execute: Effect.fail(new Activity.InfraInterrupt({ reason: "worker lost" })),
  interruptRetryPolicy: Schedule.recurs(3)
})
```

## Runtime references

`Activity.CurrentAttempt` exposes the one-based durable attempt selected by the engine. `Activity.CurrentOrdinal` carries the stable per-run ordinal used when deriving an ordinal step key. These are `Context.Reference` values; application code normally uses the activity helpers instead of setting them.

`Flow.CaptureDefects` and `Flow.SuspendOnFailure` are also context references. Treat overrides as engine policy because they change which outcomes are terminal.

## Host effects and permission effects

The `@smthrs/platform-*` packages provide raw platform capabilities. `@smthrs/kernel-next` owns the closed list of ports and provides decorated services that check an exact capability through `GrantStore` before delegating. Applications should expose the kernel service to untrusted flow code and keep the raw service at the composition boundary.

See [Hosts and capabilities](hosts-and-capabilities.md), [Failure and retry](failure-and-retry.md), and the [`@smthrs/flow-next` reference](../reference/flow.md).
