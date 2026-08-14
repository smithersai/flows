# Smithers Flows

Smithers Flows is a durable-execution engine built on Effect. A flow is a typed program whose side effects are recorded in a journal as they happen; when the process running it dies, the next process reads the journal and continues where the record stops.

Effect ships a workflow package of its own; this engine vendors that surface rather than depending on it, and then diverges by being stricter and more cacheable. Upstream derives a run's identity by hashing the flow tag and payload, so unrelated runs with equal payloads silently join; here the caller chooses the execution ID, derivation is opt-in, and a flow with neither dies with a structured defect. Upstream derives a step's identity from its activity's name, so renaming an activity corrupts replay; here step keys are content-addressed over canonical JSON, and a step is keyed by its content, not its name. Upstream retries any interruption ten times by default; here cancellation propagates at once, and only an interrupt explicitly marked as infrastructure consumes a retry policy.

## Quick start

You will need Node.js 22.19 or later.

```sh
pnpm add @smthrs/flow-next @smthrs/engine-next effect@4.0.0-rc.108 @effect/platform-node@4.0.0-rc.108
```

The only way to learn a new system is to write programs in it. The first program to write is the same as it has always been: print a greeting.

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine-next"
import { Action, Flow, Interpreter } from "@smthrs/flow-next"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

// The atom that does the work: schemas and a tag, no code.
export const Greet = Action.make("examples/Greet", {
  payload: { name: Schema.String },
  success: Schema.String
})

// The composite: a pure body that names the atom instead of calling it.
export const Greeting = Flow.make("examples/Greeting", {
  payload: { name: Schema.String },
  success: Schema.String,
  body: (payload) => Greet.call(payload)
})

// The implementation is attached separately, where the code can run.
const GreetingLayer = Layer.mergeAll(
  Greet.toLayer(({ name }) => Effect.succeed(`Hello, ${name}.`)),
  Interpreter.layer(Greeting)
).pipe(
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(FlowEngine.layerMemory),
  // Step identity is a derived hash, so the engine needs a Crypto even in memory.
  Layer.provideMerge(NodeCrypto.layer)
)

const program = Greeting.execute(
  { name: "Ada" },
  { executionId: "greeting-ada-1" }
).pipe(Effect.provide(GreetingLayer))

Effect.runPromise(program).then(console.log)
// "Hello, Ada."
```

The engine above keeps its state in the process, which is fine for a first program and no help in a crash. To survive one, drive the same flow, unchanged, with `EngineStore.layer` over SQLite; the examples below show the wiring.

## Examples

There are nine, in [`examples/src`](examples/src), numbered in reading order. `pnpm run test:examples` runs every one against the real packages.

- [`01-define-and-run.ts`](examples/src/01-define-and-run.ts) — define a typed flow and run it on the in-memory engine
- [`02-run-durably.ts`](examples/src/02-run-durably.ts) — run a flow on the durable engine and read the journal it wrote
- [`03-crash-and-resume.ts`](examples/src/03-crash-and-resume.ts) — suspend a run, drop the engine, and resume from durable state
- [`04-retry-policy.ts`](examples/src/04-retry-policy.ts) — retry a flaky action, and read the policy that decides when to stop
- [`05-time-travel-fork.ts`](examples/src/05-time-travel-fork.ts) — fork a finished run at a journal frame and drive the copy
- [`06-time-travel-rewind.ts`](examples/src/06-time-travel-rewind.ts) — rewind a run to an earlier frame and re-derive a view
- [`07-sync-follower.ts`](examples/src/07-sync-follower.ts) — follow a run's journal from a second process
- [`08-host-adapters.ts`](examples/src/08-host-adapters.ts) — run the same host program against two adapters
- [`09-browser-use.ts`](examples/src/09-browser-use.ts) — use the library from a browser bundle

## Features

- Schema-typed payloads, successes, and errors.
- One transaction per step.
- Fenced ownership; zombie owners interrupt themselves.
- Durable deferreds, clocks, and queues.
- Retry deadlines survive restarts.
- Content-addressed step keys.
- Grant-checked host access.
- Node, Bun, browser, and test hosts.
- Read-only follower sync.
- Replay, fork, rewind, compensate, recover.
- Layers, not hooks.

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
| `@smthrs/artifacts-next` | Content-addressed artifact store, local and remote |
| `@smthrs/database-next` | Driver-neutral SQL contract with transactional write retry |
| `@smthrs/capability-next` | Capability vocabulary and typed permission failures, shared by the kernel and `@smthrs/jj-next` |
| `@smthrs/kernel-next` | The closed host service list, capability sets, grants, and permission-decorated host services |
| `@smthrs/crypto-next` | Injected cryptographic schema transformations |
| `@smthrs/keys-next` | Canonical flow keys |
| `@smthrs/plan-next` | The persisted plan: a keyed action graph, its append-only store, and its diff |
| `@smthrs/flow-next` | Flow definitions, actions, durable primitives, retry policy, and the `FlowRuntime` port |
| `@smthrs/engine-next` | The runtime that executes flows, plus the RPC and HTTP façades |
| `@smthrs/engine-store-next` | The durable engine: claims, fences, and persists runs over the journal |
| `@smthrs/sync-next` | Read-only journal replication for followers |
| `@smthrs/time-travel-next` | Replay, fork, rewind, compensation, and recovery protocols |

## Documentation

`pnpm exec vocs dev` serves the documentation site locally; the pages are under [docs/pages](docs/pages).
