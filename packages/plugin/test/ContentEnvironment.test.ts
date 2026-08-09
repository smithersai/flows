/**
 * Issue #88: `Activity.CurrentContentEnvironment` had zero production
 * providers — the machinery issue #75 added defaulted to the empty
 * environment in every shipped composition, so swapping a model or host
 * plugin left every sealed content digest byte-identical and served the
 * stale cross-run cache entry.
 *
 * The plugin kernel is the composition that wires those layers, so it is the
 * component that declares the known part of the environment: the merged
 * layer provides resolved plugin identities as content-key material. Until
 * the application supplies the complete capability identity, the engine
 * keeps the resulting keys run-local.
 */
import { Activity } from "@smthrs/engine"
import { Context, Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import * as Kernel from "../src/Kernel.ts"
import * as Plugin from "../src/Plugin.ts"

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(effect as Effect.Effect<A, E>)

class Marker extends Context.Service<Marker, string>()("ContentEnvironment/Marker") {}

describe("the kernel declares the content environment (issue #88)", () => {
  it("provides the resolved plugin identities through the merged layer", async () => {
    const kernel = await run(Kernel.make([
      Plugin.make({ name: "flows-plugin-model-sonnet" }),
      Plugin.make({
        name: "flows-plugin-host-local",
        layer: Layer.succeed(Marker)("host")
      })
    ]))
    const environment = await run(
      Effect.gen(function*() {
        // A plugin-contributed service and the environment resolve from the
        // same merged layer.
        expect(yield* Marker).toBe("host")
        return yield* Activity.CurrentContentEnvironment
      }).pipe(Effect.provide(kernel.layer))
    )
    // Asserted as a whole value, not just `.layers`: `undefined` is the
    // engine's "nothing was declared" state, which scopes sealed content keys
    // to a single run. A kernel that produced it would be an issue-#88
    // regression that the property access alone would not catch.
    expect(environment).toEqual({
      layers: ["flows-plugin-model-sonnet", "flows-plugin-host-local"]
    })
  })

  it("a swapped plugin changes the declared environment", async () => {
    const layersOf = (name: string) =>
      run(Kernel.make([Plugin.make({ name })])).then((kernel) =>
        run(
          Effect.gen(function*() {
            return yield* Activity.CurrentContentEnvironment
          }).pipe(Effect.provide(kernel.layer))
        )
      )
    const sonnet = await layersOf("flows-plugin-model-sonnet")
    const opus = await layersOf("flows-plugin-model-opus")
    expect(sonnet).toEqual({ layers: ["flows-plugin-model-sonnet"] })
    expect(sonnet).not.toEqual(opus)
  })

  it("a layer-less plugin list still declares its identities", async () => {
    const kernel = await run(Kernel.make([Plugin.make({ name: "flows-plugin-hooks-only" })]))
    const environment = await run(
      Effect.gen(function*() {
        return yield* Activity.CurrentContentEnvironment
      }).pipe(Effect.provide(kernel.layer))
    )
    expect(environment).toEqual({ layers: ["flows-plugin-hooks-only"] })
  })

  it("accepts a complete capability and non-plugin layer identity", async () => {
    const kernel = await run(Kernel.make(
      [Plugin.make({ name: "flows-plugin-model-sonnet" })],
      {},
      {
        contentEnvironment: {
          layers: ["Host=node"],
          capabilities: { fs: ["/workspace/**"] }
        }
      }
    ))
    const environment = await run(
      Effect.gen(function*() {
        return yield* Activity.CurrentContentEnvironment
      }).pipe(Effect.provide(kernel.layer))
    )
    expect(environment).toEqual({
      layers: ["flows-plugin-model-sonnet", "Host=node"],
      capabilities: { fs: ["/workspace/**"] }
    })
  })
})
