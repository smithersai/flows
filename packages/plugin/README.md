# @smithers/plugin

The flows plugin kernel: a Vite-shaped, Effect-native extension seam.

Governing spec: [`docs/architecture/plugin-system.md`](../../docs/architecture/plugin-system.md).

This package ships exactly three things:

1. **A typed hook surface** — `FlowsHooks`, declared in the package entry point so
   `declare module "@smithers/plugin"` augmentation merges into it. Each entry is
   either a bare handler or `{ order?: "pre" | "post", handler }`, and its dispatch
   kind is fixed in the type: `SequentialHook`, `ParallelHook`, `FirstHook`,
   `WaterfallHook`.
2. **Resolution and ordering** — `Resolve.resolve` flattens nested arrays, drops
   falsy entries, applies `apply` filters, rejects duplicate names, and partitions
   `pre` / normal / `post` (then per-hook `order` within each hook). It runs once
   and produces a frozen ordered handler list per hook; runtime dispatch is an
   array walk.
3. **Config execution** — `Kernel.make` runs the `config` waterfall, decodes and
   freezes a `ResolvedConfig`, then fires `configResolved` in parallel and merges
   plugin layers with `Layer.provideMerge`, left to right.

```ts
import { Effect, Option } from "effect"
import type { FlowsPlugin } from "@smithers/plugin"
import { Kernel } from "@smithers/plugin"

const quotaPark = (): FlowsPlugin => ({
  name: "flows-plugin-quota-park",
  hooks: {
    classifyError: (error) => Effect.succeed(isQuota(error) ? Option.some("transient") : Option.none()),
    waitStart: (wait) => wait.reason === "quota" ? Effect.log(`parked until ${wait.wakeAt}`) : Effect.void
  }
})

const kernel = yield* Kernel.make([quotaPark()], { engine: { maxConcurrency: 8 } })
yield* kernel.plugins.parallel("runStart", { runId })
```

Hooks declared here that nothing consumes yet are types plus registry support
only — the engine call sites land with their consumers. Cancellation is fiber
interruption through scope closure; there is no `AbortSignal` anywhere.
