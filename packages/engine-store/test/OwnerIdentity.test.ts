/**
 * The owner identity port: what the default mints on a host with a process,
 * what it mints on one without (a browser tab), and that a composition can
 * pin the whole token instead.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as OwnerIdentity from "../src/OwnerIdentity.ts"

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe("OwnerIdentity", () => {
  it("mints the reported process id and a fresh nonce per call", async () => {
    const identity = OwnerIdentity.makeIncarnation(4242)
    const first = await Effect.runPromise(identity.ownerId("some-host"))
    const second = await Effect.runPromise(identity.ownerId("some-host"))

    expect(first.hostId).toBe("some-host")
    expect(first.pid).toBe(4242)
    expect(first.nonce).toMatch(uuid)
    // The nonce is what makes two incarnations on one host distinguishable,
    // so it must never repeat — that is the whole fencing guarantee.
    expect(second.nonce).not.toBe(first.nonce)
  })

  it("draws an incarnation number on a host with no process (a browser tab)", async () => {
    const identity = OwnerIdentity.makeIncarnation(undefined)
    const owner = await Effect.runPromise(identity.ownerId("tab-host"))

    expect(Number.isSafeInteger(owner.pid)).toBe(true)
    expect(owner.pid).toBeGreaterThanOrEqual(0)
    expect(owner.nonce).toMatch(uuid)
  })

  it("provides the platform default through the layer", async () => {
    const owner = await Effect.runPromise(
      Effect.flatMap(OwnerIdentity.OwnerIdentity, (identity) => identity.ownerId("layer-host")).pipe(
        Effect.provide(OwnerIdentity.layer)
      )
    )

    // The suite runs on node, so the default reports this process.
    expect(owner).toEqual({ hostId: "layer-host", pid: process.pid, nonce: owner.nonce })
    expect(owner.nonce).toMatch(uuid)
  })

  it("lets a composition pin the whole token", async () => {
    const pinned = { hostId: "pinned-host", pid: 7, nonce: "pinned-nonce" }
    const owner = await Effect.runPromise(
      Effect.flatMap(OwnerIdentity.OwnerIdentity, (identity) => identity.ownerId("ignored")).pipe(
        Effect.provide(OwnerIdentity.layerConstant(pinned))
      )
    )

    expect(owner).toEqual(pinned)
  })
})
