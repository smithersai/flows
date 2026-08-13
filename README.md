# Smithers Flows

Smithers Flows is an Effect-based durable-execution engine: typed flows that record every side effect to a journal, so a crashed process resumes from its recorded steps instead of starting over.

You declare an activity once with Schema-typed payload, success, and error, attach its implementation as a layer, and write a flow whose pure body names it. The engine persists run state in SQLite through the journal, computes a content-addressed key for each activity, and stores each attempt's encoded result. When a process restarts, it claims the run, re-plans the flow and drives it from the top, and replays every recorded step; the first step without a record is where new work happens. A capability kernel bounds what flow code can reach on the host, read-only sync streams journal entries to followers, and time travel forks and rewinds run history.

## Quick start

Requires Node.js 22.19 or later.

```sh
npm install @smthrs/flow-next @smthrs/engine-next effect
```

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine-next"
import { Activity, Flow, Interpreter } from "@smthrs/flow-next"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

// The atom that does the work: schemas and a tag, no code.
export const Greet = Activity.make("example/Greet", {
  payload: { name: Schema.String },
  success: Schema.String
})

// The composite: a pure body that names the atom instead of calling it.
export const Greeting = Flow.make("example/Greeting", {
  payload: { name: Schema.String },
  success: Schema.String,
  body: (payload) => Greet.call(payload)
})

// The implementation is attached separately, where the code can run.
const GreetingLayer = Layer.mergeAll(
  Greet.toLayer(({ name }) => Effect.succeed(`Hello, ${name}.`)),
  Interpreter.layer(Greeting)
).pipe(
  Layer.provideMerge(Activity.layerImplementations),
  Layer.provideMerge(FlowEngine.layerMemory),
  Layer.provideMerge(NodeCrypto.layer)
)

const program = Greeting.execute(
  { name: "Ada" },
  { executionId: "greeting-ada-1" }
).pipe(Effect.provide(GreetingLayer))

Effect.runPromise(program).then(console.log)
// "Hello, Ada."
```

The in-memory engine above keeps state in the process. For a run that survives a crash, drive the same flow with `EngineStore.layer` over SQLite; `examples/src/02-run-durably.ts` and `examples/src/03-crash-and-resume.ts` show the full wiring, and `npm run test:examples` executes every example against the real packages.

## Features

- Typed flows and activities with Schema-encoded payloads, successes, and expected errors (`Flow.make`, `Activity.make`).
- Journal-backed durability: run rows, attempt rows, cache rows, and their lifecycle events commit in one transaction.
- Fenced run ownership with heartbeats, liveness-gated takeover, and self-interrupting zombie owners.
- Durable deferreds, clocks, and queues that re-arm across restarts.
- Retry policies whose schedule-to-close origin persists across park, resume, and process death.
- Content-addressed step keys over canonical serialization, with invocation keys for run-local work.
- A capability kernel that decorates host services with grant-checked permissions.
- Host adapters for Node, Bun, browser, and tests behind one closed service surface.
- Read-only catch-up and follow sync of journal entries over Effect RPC.
- Time travel over run history: frame-addressed replay, fork, rewind, compensation, recovery.
- Extension by dependency injection: every replaceable behavior is an Effect service or a constructor option with a default, so a `Layer` swaps it.

## Packages

| Package | Role |
| --- | --- |
| `@smthrs/flows-next` | Umbrella barrel re-exporting the engine packages below as namespaces; the `platform-*` bundles are deliberately excluded |
| `@smthrs/canonical-next` | RFC 8785 canonical JSON as an Effect Schema |
| `@smthrs/platform-node-next` | The Node Host bundle: Effect's Node platform services, the Undici transport, and the Node jj adapter |
| `@smthrs/platform-bun-next` | The same bundle for Bun, over `@effect/platform-bun` |
| `@smthrs/jj-next` | Jujutsu snapshot, restore, diff, and workspace operations as a host service |
| `@smthrs/sandbox-next` | Remote `ChildProcessSpawner` implementation and the sandbox liveness probe |
| `@smthrs/platform-browser-next` | Browser `FileSystem` and `ChildProcessSpawner` over ZenFS and just-bash, plus the `BrowserHost` bundle |
| `@smthrs/journal-next` | Logical WAL, migrations, projections, redaction, the `OwnerId` fence |
| `@smthrs/run-store-next` | Run and attempt stores, ownership arbitration, migrations |
| `@smthrs/step-cache-next` | Sealed step result cache and its migration |
| `@smthrs/database-next` | Driver-neutral SQL contract with transactional write retry |
| `@smthrs/capability-next` | Capability vocabulary and typed permission failures, shared by the kernel and `@smthrs/jj-next` |
| `@smthrs/kernel-next` | The closed host service list, capability sets, grants, and permission-decorated host services |
| `@smthrs/crypto-next` | Injected cryptographic schema transformations |
| `@smthrs/keys-next` | Canonical flow keys |
| `@smthrs/flow-next` | Flow definitions, activities, durable primitives, retry policy, and the `FlowRuntime` port |
| `@smthrs/engine-next` | The runtime that executes flows, plus the RPC and HTTP façades |
| `@smthrs/engine-store-next` | The durable engine: claims, fences, and persists runs over the journal |
| `@smthrs/sync-next` | Read-only journal replication for followers |
| `@smthrs/time-travel-next` | Replay, fork, rewind, compensation, and recovery protocols |

## Documentation

Serve the docs site locally with `npx vocs dev`. Start with [Architecture](docs/pages/architecture.md) and [Data structures](docs/pages/data-structures.md), then the per-package API pages under [docs/pages/api](docs/pages/api). [Design decisions](docs/pages/design-decisions.md) records why the engine looks this way, and [External](docs/pages/external.md) lists deployment limits and implementation status.

## Status and compatibility

Packages are pre-1.0 at 0.1.0 in lockstep. The shipped database backends are SQLite (Node and in-memory); Postgres and PGlite parity is an accepted, documented gap. Every package root bundles for the browser, including `@smthrs/engine-store-next` and the `@smthrs/flows-next` barrel; only the platform bundles, the jj and SQLite drivers, and the test hosts are Node-only. Bundling is not running — no browser SQL client layer ships here yet.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Before opening a pull request, run `npm run check`, `npm test`, `npm run lint`, `npm run circular`, and `npm run browser`.
