import { Duration, Effect, Exit } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as BranchProtocol from "../src/BranchProtocol.ts"
import * as BranchShare from "../src/BranchShare.ts"
import { SyncError } from "../src/SyncError.ts"

const branchId = "live-branch" as BranchProtocol.BranchId
const otherBranchId = "other-branch" as BranchProtocol.BranchId

const authority = BranchShare.makeHmac({ secret: "share-secret" })

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer())))

const mintWrite = Effect.flatMap(
  authority,
  (share) => share.mint({ branchId, capabilityId: "cap-1", access: "write", ttlMs: 60_000 })
)

describe("BranchShare", () => {
  it("mints a capability whose claims are scoped, timed, and verifiable", async () => {
    const [capability, claims] = await run(
      Effect.gen(function*() {
        const share = yield* authority
        const minted = yield* share.mint({ branchId, capabilityId: "cap-1", access: "write", ttlMs: 60_000 })
        return [minted, yield* share.verify(minted, { branchId, access: "write" })] as const
      })
    )

    expect(capability.claims.branchId).toBe(branchId)
    expect(capability.claims.expiresAtMs - capability.claims.issuedAtMs).toBe(60_000)
    expect(capability.signature).toMatch(/^[0-9a-f]{64}$/)
    expect(claims.capabilityId).toBe("cap-1")
  })

  it("rejects a tampered signature without leaking its length", async () => {
    const failures = await run(
      Effect.gen(function*() {
        const share = yield* authority
        const capability = yield* mintWrite
        const flipped = new BranchProtocol.ShareCapability({
          claims: capability.claims,
          signature: `0${capability.signature.slice(1)}`
        })
        const truncated = new BranchProtocol.ShareCapability({ claims: capability.claims, signature: "" })
        return [
          yield* Effect.flip(share.verify(flipped, { branchId, access: "read" })),
          yield* Effect.flip(share.verify(truncated, { branchId, access: "read" }))
        ]
      })
    )

    for (const failure of failures) {
      expect(failure.code).toBe("unauthorized")
      expect(failure.message).toBe("The share capability signature is invalid")
    }
  })

  it("rejects a capability replayed against another branch", async () => {
    const failure = await run(
      Effect.gen(function*() {
        const share = yield* authority
        const capability = yield* mintWrite
        return yield* Effect.flip(share.verify(capability, { branchId: otherBranchId, access: "read" }))
      })
    )

    expect(failure.code).toBe("unauthorized")
    expect(failure.message).toContain(branchId)
  })

  it("rejects an expired capability at the instant the lease runs out", async () => {
    const outcome = await run(
      Effect.gen(function*() {
        const share = yield* authority
        const capability = yield* share.mint({
          branchId,
          capabilityId: "cap-short",
          access: "write",
          ttlMs: 1_000
        })
        yield* TestClock.adjust(Duration.millis(999))
        const stillValid = yield* share.verify(capability, { branchId, access: "write" })
        yield* TestClock.adjust(Duration.millis(1))
        return [
          stillValid.capabilityId,
          yield* Effect.flip(share.verify(capability, { branchId, access: "read" }))
        ] as const
      })
    )

    expect(outcome[0]).toBe("cap-short")
    expect(outcome[1].message).toBe("The share capability has expired")
  })

  it("refuses to widen a read capability into write access", async () => {
    const outcome = await run(
      Effect.gen(function*() {
        const share = yield* authority
        const capability = yield* share.mint({
          branchId,
          capabilityId: "cap-read",
          access: "read",
          ttlMs: 60_000
        })
        return [
          (yield* share.verify(capability, { branchId, access: "read" })).access,
          yield* Effect.flip(share.verify(capability, { branchId, access: "write" }))
        ] as const
      })
    )

    expect(outcome[0]).toBe("read")
    expect(outcome[1].message).toBe("The share capability is read-only")
  })

  it("distinguishes claim sets whose fields would concatenate identically", async () => {
    const signatures = await run(
      Effect.gen(function*() {
        const share = yield* authority
        const left = yield* share.mint({
          branchId: "ab" as BranchProtocol.BranchId,
          capabilityId: "c",
          access: "read",
          ttlMs: 1_000
        })
        const right = yield* share.mint({
          branchId: "a" as BranchProtocol.BranchId,
          capabilityId: "bc",
          access: "read",
          ttlMs: 1_000
        })
        return [left.signature, right.signature]
      })
    )

    expect(signatures[0]).not.toBe(signatures[1])
  })

  it("verifies through the provided layer", async () => {
    const access = await run(
      Effect.gen(function*() {
        const share = yield* BranchShare.BranchShare
        const capability = yield* share.mint({ branchId, capabilityId: "cap-l", access: "write", ttlMs: 1_000 })
        return (yield* share.verify(capability, { branchId, access: "write" })).access
      }).pipe(Effect.provide(BranchShare.layerHmac({ secret: "layer-secret" })))
    )

    expect(access).toBe("write")
  })

  it("refuses everything through the noop layer, and honours overrides", async () => {
    const mintExit = await Effect.runPromiseExit(
      Effect.flatMap(
        BranchShare.BranchShare,
        (share) => share.mint({ branchId, capabilityId: "cap", access: "read", ttlMs: 1 })
      ).pipe(
        Effect.provide(BranchShare.layerNoop)
      )
    )
    const verifyFailure = await Effect.runPromise(
      Effect.flatMap(BranchShare.BranchShare, (share) =>
        Effect.flip(
          share.verify(
            new BranchProtocol.ShareCapability({
              claims: new BranchProtocol.ShareClaims({
                branchId,
                capabilityId: "cap",
                access: "read",
                issuedAtMs: 0,
                expiresAtMs: 1
              }),
              signature: ""
            }),
            { branchId, access: "read" }
          )
        )).pipe(Effect.provide(BranchShare.layerNoop))
    )
    const overridden = BranchShare.makeNoop({
      verify: () => Effect.fail(new SyncError({ code: "unauthorized", message: "overridden" }))
    })

    expect(Exit.isFailure(mintExit)).toBe(true)
    expect(verifyFailure.message).toBe("Branch sharing is unavailable")
    expect(
      (await Effect.runPromise(
        Effect.flip(
          overridden.verify(
            new BranchProtocol.ShareCapability({
              claims: new BranchProtocol.ShareClaims({
                branchId,
                capabilityId: "cap",
                access: "read",
                issuedAtMs: 0,
                expiresAtMs: 1
              }),
              signature: ""
            }),
            { branchId, access: "read" }
          )
        )
      )).message
    ).toBe("overridden")
  })

  it("keeps `make` an identity over an implementation", () => {
    const implementation = BranchShare.makeNoop()
    expect(BranchShare.make(implementation).verify).toBe(implementation.verify)
  })
})
