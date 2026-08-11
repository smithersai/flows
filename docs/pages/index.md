# Smithers Flows

Smithers Flows is an Effect-based durable-execution engine: typed flows that record every side effect to a journal, so a crashed process resumes from its recorded steps instead of starting over.

You define a flow once with Schema-typed payload, success, and error, and register its handler as a layer. The engine persists run state in SQLite through the journal, computes a content-addressed key for each activity, and stores each attempt's encoded result. When a process restarts, it claims the run, re-invokes your handler from the top, and replays every recorded step; the first step without a record is where new work happens. A capability kernel bounds what flow code can reach on the host, read-only sync streams journal entries to followers, and time travel forks and rewinds run history.

## Quick start

Requires Node.js 22.19 or later.

```sh
npm install @smthrs/flow @smthrs/engine effect
```

```ts
import { FlowEngine } from "@smthrs/engine"
import { Flow } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

export const Greeting = Flow.make("example/Greeting", {
  payload: { name: Schema.String },
  success: Schema.String
})

const GreetingLayer = Greeting.toLayer(({ name }) =>
  Effect.succeed(`Hello, ${name}.`)
).pipe(Layer.provideMerge(FlowEngine.layerMemory))

const program = Greeting.execute(
  { name: "Ada" },
  { executionId: "greeting-ada-1" }
).pipe(Effect.provide(GreetingLayer))

Effect.runPromise(program).then(console.log)
// "Hello, Ada."
```

That engine keeps its state in the process. To survive a crash, drive the same flow with `EngineStore.layer` over SQLite. [Examples](/examples) walks the nine runnable programs that do it, and `npm run test:examples` executes every one of them against the real packages.

## Where to go next

| If you want to | Read |
| --- | --- |
| see how the pieces fit together | [Architecture](/architecture) |
| know what is stored and what holds true about it | [Data structures](/data-structures) |
| know which package owns what, and what bundles for a browser | [Package structure](/package-structure) |
| look up an export | [Public API](/api/flows) |
| change the engine | [Internal details](/internals) and [Contributor plan](/contributing) |
| debug a running flow | [Observability](/observability) |
| understand why it works this way | [Design decisions](/design-decisions) |
| find out what it cannot do yet | [External](/external) |

## Packages

| Package | Role |
| --- | --- |
| `@smthrs/flows` | umbrella barrel re-exporting the engine packages below as namespaces; the `platform-*` bundles are deliberately excluded |
| `@smthrs/canonical` | RFC 8785 canonical JSON as an Effect Schema |
| `@smthrs/platform-node` | the Node Host bundle: Effect's Node filesystem and child-process spawner, the Undici transport, and the Node jj adapter |
| `@smthrs/platform-bun` | the same bundle for Bun, over `@effect/platform-bun` |
| `@smthrs/jj` | jujutsu snapshot, restore, diff, and workspace operations as a host service |
| `@smthrs/sandbox` | remote-sandbox provider adaptation and the sandbox liveness probe |
| `@smthrs/platform-browser` | browser `FileSystem` and `ChildProcessSpawner` over ZenFS and just-bash |
| `@smthrs/journal` | logical WAL, migrations, projections, redaction, the `OwnerId` fence |
| `@smthrs/run-store` | run and attempt stores, ownership arbitration, migrations |
| `@smthrs/step-cache` | the sealed step result cache and its migration |
| `@smthrs/database` | driver-neutral SQL contract with transactional write retry |
| `@smthrs/capability` | the capability vocabulary and typed permission failures, shared by the kernel and `@smthrs/jj` |
| `@smthrs/kernel` | capability sets, grants, and permission-decorated host services |
| `@smthrs/crypto` | injected cryptographic schema transformations |
| `@smthrs/keys` | canonical flow keys |
| `@smthrs/flow` | flow definitions, activities, durable primitives, retry policy |
| `@smthrs/engine` | the engine that executes them, plus the RPC and HTTP façades |
| `@smthrs/engine-store` | the durable engine: claims, fences, and persists runs over the journal |
| `@smthrs/sync` | read-only journal replication for followers |
| `@smthrs/time-travel` | replay, fork, rewind, compensation, and recovery protocols |

Packages are pre-1.0 at `0.1.0` in lockstep. Every engine package — including `@smthrs/engine-store` and the barrel — bundles for the browser; the `platform-node`, `platform-bun`, and driver subpaths are the deliberate Node-only entry points.
