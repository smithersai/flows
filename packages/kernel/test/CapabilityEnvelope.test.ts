import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { Capability, CapabilityPattern } from "../src/Capability.ts"
import * as CapabilityEnvelope from "../src/CapabilityEnvelope.ts"
import * as CapabilitySet from "../src/CapabilitySet.ts"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const pattern = (action: CapabilityPattern["action"], resource: string) => new CapabilityPattern({ action, resource })

const netGet = new Capability({ action: "net:get", resource: "https://example.com/data" })
const fsWrite = new Capability({ action: "fs:write", resource: "/workspace/out.txt" })

describe("CapabilityEnvelope", () => {
  it("round-trips through its JSON encoding", () =>
    run(Effect.gen(function*() {
      const envelope = CapabilityEnvelope.make([pattern("net:*", "**"), pattern("fs:read", "/workspace/**")])
      const encoded = yield* CapabilityEnvelope.encode(envelope)
      // the wire value is plain JSON: survives stringify/parse untouched
      const wire: unknown = JSON.parse(JSON.stringify(encoded))
      const decoded = yield* CapabilityEnvelope.decode(wire)
      expect(decoded.version).toBe(CapabilityEnvelope.version)
      expect(decoded.patterns).toHaveLength(2)
      expect(decoded.patterns[0]?.action).toBe("net:*")
    })))

  it("fails closed on an unknown version", async () => {
    const exit = await Effect.runPromiseExit(
      CapabilityEnvelope.decode({ version: "flows/capability-envelope/v2", patterns: [] })
    )
    expect(exit._tag).toBe("Failure")
  })

  it("fails closed on a malformed value", async () => {
    const exit = await Effect.runPromiseExit(CapabilityEnvelope.decode("not an envelope"))
    expect(exit._tag).toBe("Failure")
  })

  it("apply intersects: the envelope narrows ambient authority", () =>
    run(
      Effect.gen(function*() {
        const set = yield* CapabilitySet.current
        expect(CapabilitySet.allows(set, netGet)).toBe(true)
        expect(CapabilitySet.allows(set, fsWrite)).toBe(true)
      }).pipe(
        CapabilityEnvelope.apply(
          CapabilityEnvelope.make([pattern("net:*", "**"), pattern("fs:write", "/workspace/**")])
        )
      )
    ))

  it("apply denies capabilities outside the envelope", () =>
    run(
      Effect.gen(function*() {
        const set = yield* CapabilitySet.current
        expect(CapabilitySet.allows(set, netGet)).toBe(false)
        expect(CapabilitySet.allows(set, fsWrite)).toBe(true)
      }).pipe(
        CapabilityEnvelope.apply(CapabilityEnvelope.make([pattern("fs:*", "**")]))
      )
    ))

  it("the empty envelope denies everything", () =>
    run(
      Effect.gen(function*() {
        const set = yield* CapabilitySet.current
        expect(CapabilitySet.allows(set, netGet)).toBe(false)
        expect(CapabilitySet.allows(set, fsWrite)).toBe(false)
      }).pipe(CapabilityEnvelope.apply(CapabilityEnvelope.make([])))
    ))

  it("apply cannot widen an already-attenuated fiber", () =>
    run(
      Effect.gen(function*() {
        const set = yield* CapabilitySet.current
        // The outer attenuation to fs-only still applies even though the
        // envelope would allow the network.
        expect(CapabilitySet.allows(set, netGet)).toBe(false)
        expect(CapabilitySet.allows(set, fsWrite)).toBe(true)
      }).pipe(
        CapabilityEnvelope.apply(CapabilityEnvelope.make([pattern("*", "**")])),
        CapabilitySet.attenuate([pattern("fs:*", "**")])
      )
    ))

  it("interpret decodes then applies in one step", () =>
    run(Effect.gen(function*() {
      const wire = yield* CapabilityEnvelope.encode(
        CapabilityEnvelope.make([pattern("net:get", "https://example.com/**")])
      )
      const set = yield* CapabilityEnvelope.interpret(wire)(CapabilitySet.current)
      expect(CapabilitySet.allows(set, netGet)).toBe(true)
      expect(CapabilitySet.allows(set, fsWrite)).toBe(false)
    })))

  it("interpret fails with CapabilityEnvelopeError on garbage", async () => {
    const exit = await Effect.runPromiseExit(
      CapabilityEnvelope.interpret({ nonsense: true })(Effect.void)
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(String(exit.cause)).toContain("CapabilityEnvelopeError")
    }
  })
})
