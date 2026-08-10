/**
 * Use the library from a browser bundle.
 *
 * Every import in this file comes from an entry point that the repository's
 * browser gate (`npm run browser`) bundles with esbuild `platform: "browser"`:
 * the `@smthrs/engine`, `@smthrs/keys`, `@smthrs/journal`, and `@smthrs/host`
 * roots never statically resolve a `node:` built-in, because platform access
 * lives in layers under `/node`, `/bun`, `/browser`, and `/test` subpaths.
 *
 * The barrel `@smthrs/flows` and `@smthrs/engine-store` are Node entry points,
 * so a browser app imports the per-package roots, as this file does. The test
 * for this example bundles the file itself for the browser and fails if a
 * Node-only import ever sneaks in.
 */
import { Flow, FlowEngine } from "@smthrs/engine"
import { Key } from "@smthrs/keys"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Crypto from "effect/Crypto"

export const Compile = Flow.make("examples/Compile", {
  payload: { target: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ target }) => target
})

const CompileLayer = Compile.toLayer(({ target }) => Effect.succeed(`built ${target}`)).pipe(
  Layer.provideMerge(FlowEngine.layerMemory)
)

export interface Summary {
  readonly result: string
  readonly stepKey: string
}

export const main: Effect.Effect<Summary, never, Crypto.Crypto> = Effect.gen(function*() {
  const result = yield* Compile.execute({ target: "web" })

  const key = yield* Schema.decodeUnknownEffect(Key)({
    body: "examples/compile/v1",
    target: "web"
  })

  return { result, stepKey: key }
}).pipe(Effect.provide(CompileLayer), Effect.orDie)
