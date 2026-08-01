import { Effect, Layer, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { CacheStore } from "../src/CacheStore.ts"
import * as CacheStoreLive from "../src/CacheStore.ts"
import * as Notifying from "../src/test/Notifying.ts"

const record = (log: Array<string>): Notifying.Hook => (op, order, args) =>
  Effect.sync(() => {
    log.push(`${op}:${order}:${args.length}`)
  })

describe("Notifying", () => {
  it("fires the hook around Effect-valued methods and plain Effect properties", async () => {
    const log: Array<string> = []
    const service = {
      lookup: (key: string) => Effect.succeed(`value-${key}`),
      ready: Effect.succeed("ready"),
      // Non-Effect members delegate untouched, so a `Stream`-returning method
      // keeps working through the wrapper.
      watch: () => Stream.make(1, 2),
      label: "plain"
    }
    const wrapped = Notifying.wrap(service, record(log))

    expect(await Effect.runPromise(wrapped.lookup("a"))).toBe("value-a")
    expect(await Effect.runPromise(wrapped.ready)).toBe("ready")
    expect(await Effect.runPromise(Stream.runCollect(wrapped.watch()))).toEqual([1, 2])
    expect(wrapped.label).toBe("plain")
    expect(log).toEqual(["lookup:before:1", "lookup:after:1", "ready:before:0", "ready:after:0"])
  })

  it("skips the `after` firing when the delegated operation fails", async () => {
    const log: Array<string> = []
    const wrapped = Notifying.wrap({ boom: () => Effect.fail("nope") }, record(log))

    expect(await Effect.runPromise(Effect.flip(wrapped.boom()))).toBe("nope")
    expect(log).toEqual(["boom:before:0"])
  })

  it("re-provides a real service under the same key as a layer", async () => {
    const log: Array<string> = []
    const layer = Notifying.layer(CacheStore, record(log)).pipe(
      Layer.provide(
        Layer.succeed(CacheStore)(CacheStoreLive.makeNoop({
          evict: () => Effect.void
        }))
      )
    )

    await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* CacheStore
        yield* store.evict("digest")
      }).pipe(Effect.provide(layer))
    )

    expect(log).toEqual(["evict:before:1", "evict:after:1"])
  })
})
