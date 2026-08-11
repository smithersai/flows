/**
 * The identifier port the branch handlers mint through: the Web Crypto
 * default, and the deterministic counter a reproducible composition supplies
 * in its place.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as BranchIds from "../src/BranchIds.ts"

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe("BranchIds", () => {
  it("mints unguessable, never-repeating ids by default", async () => {
    const ids = BranchIds.makeWebCrypto()
    const first = await Effect.runPromise(ids.fresh)
    const second = await Effect.runPromise(ids.fresh)

    expect(first).toMatch(uuid)
    expect(second).not.toBe(first)
  })

  it("provides the default through the layer", async () => {
    const value = await Effect.runPromise(
      Effect.flatMap(BranchIds.BranchIds, (ids) => ids.fresh).pipe(Effect.provide(BranchIds.layer))
    )

    expect(value).toMatch(uuid)
  })

  it("counts deterministically when a composition asks it to", async () => {
    const values = await Effect.runPromise(
      Effect.flatMap(BranchIds.BranchIds, (ids) => Effect.all([ids.fresh, ids.fresh, ids.fresh])).pipe(
        Effect.provide(BranchIds.layerSequential("branch"))
      )
    )

    expect(values).toEqual(["branch-1", "branch-2", "branch-3"])
  })
})
