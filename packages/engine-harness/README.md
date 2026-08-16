# @smthrs/engine-harness

The production binding of the `@smthrs/harness` engine port (`EngineLike`)
onto the durable flow engine in `@smthrs/engine`.

`@smthrs/harness` owns the _port_ — `sealStep`, `call`, `splice`, `record`, `suspend` — and
ships only `EngineLike.layer(implementation)` and `EngineLike.layerNoop()`. It
deliberately does not depend on any engine: the browser app supplies its own
in-tab implementation, and pulling the durable engine into the port package
would put it in every harness consumer's bundle. This package is the other
implementation, kept separate for the same reason `platform-node` is separate
from the platform contracts in the effect repo.

## Start here: `CellHarness`

`CellHarness.run` is the default production entry point. It composes the whole cell path — controller, sandbox, registry-backed resolution, durable engine port, plugin kernel — and returns the framework-neutral `Stream<AgentEvent>` the controller emits.

```ts
import { CellHarness, ChildFlows, StandardFlows } from "@smthrs/engine-harness"
import { Effect, Stream } from "effect"

// Inside a flow body — `FlowInstance` is per-execution.
const run = Effect.gen(function*() {
  const host = yield* Effect.context<FileSystem | Path>()
  return CellHarness.run({
    session,
    seat: "anthropic:claude-opus-5",
    prompt: task,
    model,
    route: FlowEngineLike.routeResolver(anthropic),
    registry,
    // Capabilities are flows. All of them.
    flows: [
      StandardFlows.filesystem(host),
      StandardFlows.shell(host),
      ChildFlows.source(children)
    ],
    plugins
  }).pipe(Stream.provide(CellHarness.layer))
})
```

`flows` is an ordered list of `FlowBinding.Source`s; plugin `cellFlows` handlers run after them, in resolution order. The composed catalog is what the model is shown _and_ what the boundary resolves against, so the declaration digest a cell was written against is the one checked when the call arrives. Duplicate names fail composition rather than dispatching one descriptor to another implementation.

- `StandardFlows` — `filesystem`, `shell`, `memory`, `clock` (a durable wait on the engine's `DurableClock`), and `approval` (a narrow injected `Asker` port, because a host with nobody to ask should refuse honestly rather than fake an answer).
- `ChildFlows` — subagents. An attached child needs nothing here: a dynamic or markdown flow called with `ctx.call` already runs inside its own durable boundary. Detached lifecycle — `agent/spawn`, `agent/send`, `agent/await` — is bound over an injected `Children` port, because nothing browser-safe can honestly claim to persist a detached run.
- `CellPlugin.fromBindings` — the one-liner for authoring a harness plugin that contributes capabilities.

The legacy provider-tool-call loop is `@smthrs/harness/LegacyHarness`, kept for foreign CLI adapters and named as legacy everywhere it appears.

## The composition root: `HarnessExecutor`

`HarnessExecutor.layer(options)` is the production `ControlExecutor` for
`@smthrs/control`: when the control plane accepts a launch, the executor looks
the flow up in the registry, loads its markdown prompt body, resolves its
`provider:modelId` seat through the host's `resolveSeat`, and runs
`CellHarness.run` as the body of one durable flow execution whose id is the
control run id.

The composition declares what the spec demands of a host: explicit
`Sandbox.Limits` (never unlimited), a resolved `contextWindowTokens` per seat
(`contextWindowTokensFor` is the catalog; zero would silently disable
compaction), a `Steering.Source` over the journal-backed notification queue
`Control.steer` admits into, and an approval `ask` gated in `authorize` —
before the durable boundary opens — that registers an in-run approval token,
parks the run with an encoded `Permission.PermissionRequired`, and is
re-decided against the grant store when `Control.approve` and
`Control.resume` bring the run back.

`@smthrs/cli`'s `NodeControl.layerExecutor` is the Node wiring: real
`Route.anthropic` / `Route.openai` routes with API keys read from the
environment, and `StandardFlows.filesystem/shell/memory` over the kernel's
guarded host layers.

## The engine port

```ts
import { FlowEngineLike } from "@smthrs/engine-harness"
import { Effect } from "effect"

// Inside a flow body — `FlowInstance` is per-execution.
const program = Effect.gen(function*() {
  const engine = yield* FlowEngineLike.make({
    model,
    route: FlowEngineLike.routeResolver(anthropic),
    calls: { authorize: (call) => checkGrants(call), run: (call) => runFlow(call) }
  })
  // ...provide `engine` to the harness.
})
```

## What durability buys

- **`sealStep`** resolves the route, runs `Route.prepare`, and digests the
  credential-free prepared request together with the harness's declared key
  material into a `StepKey`. That key is the sealed activity's idempotency key:
  a replayed turn re-emits the recorded model events instead of calling the
  provider again, and a provider wire change produces a new key. Credentials
  are signed on after the digest and never enter it.
- **`call`** runs one flow call from inside a running cell as its own activity
  at the tier the flow declares. A sealed call is content-addressed on its
  declaration digest, resolved layers, declared capabilities, and arguments, so
  it replays wherever it appears; anything else folds in the whole cell
  identity — session, frame, cell digest, and the call's execution ordinal — so
  two invocations stay distinct, an irreversible effect is run-scoped, and a
  cell re-executed after a park replays exactly the boundaries that already
  settled. Authorization is checked _before_ the activity opens: an activity's
  outcome is journaled, so a permission requirement raised from inside one
  would replay forever and no later grant could unblock it.
- **`splice`** runs each elaborated child as its own activity at the tier the
  child declares. A sealed child is content-addressed and replays; a
  compensable or irreversible child folds the run scope — the flow and
  execution the port was built inside — and the model's `callId` into its key,
  so two invocations of one declaration stay distinct steps and two runs that
  both labelled a call `call-1` cannot alias onto one another. That is also
  what lets the engine retry an irreversible activity at all.
- **Composition identity.** `Options.layers` is the resolved layer stack and
  plugin list the host actually built, and it is folded into every key this
  port derives. A boundary resolved under a different composition is a
  different boundary, so a plugin swap can never be served a recorded result
  from the composition it replaced. The port also declares that layer set as
  the engine's content environment (`Activity.CurrentContentEnvironment`).
- **Authority identity.** The other half of the content environment is
  `Options.capabilities`, and the port never invents it. A sealed boundary is
  cross-run cacheable, so a result computed under a broad capability envelope
  must not be served to a run with an attenuated one, even when the call
  declares identical capabilities — the envelope is what attenuates it
  (issue #75). Supplying the composition's **complete** authority is what
  makes a sealed boundary shareable across runs; omitting it is the honest
  "unknown", and the engine answers it by pinning every sealed key to the
  current execution. `CellHarness.run` declares the capability envelope it
  actually built, so hosts on that path get cross-run reuse without asserting
  anything false.
- **`record`** journals one nondeterministic controller read — the
  turn-boundary steering drain — as its own run-scoped boundary. A resumed
  run replays the recorded drain instead of reading an already-drained queue,
  which is what keeps a resume on the original attempt's sealed steps.
- **`suspend`** is a real durable suspension (`Flow.suspend`). The execution
  parks and the engine can resume it, rather than the port failing.

## Not to be confused with

`@smthrs/testing`'s `FlowEngineLike` adapts the same engine to a different
port — `EngineSubject` (`run` / `result` / `interrupt` / `resume` / `journal`),
the testing library's conformance contract. The two share a backing engine and
nothing else.
