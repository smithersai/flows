import { jjError } from "@smithers/host/HostError"
import * as Jj from "@smithers/host/Jj"
import * as CacheStore from "@smithers/journal/CacheStore"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { describe, expect, it } from "vitest"
import * as Compensation from "../src/Compensation.ts"
import type { EffectRecord } from "../src/EffectBoundary.ts"
import * as EffectHandlerRegistry from "../src/EffectHandlerRegistry.ts"
import { error } from "../src/TimeTravelError.ts"

/**
 * Rewind preflight decides, before a single effect is undone, whether the
 * crossed suffix can be reversed at all. Compensation then executes in reverse
 * journal order and must leave nothing half-done: a failed revert rolls back
 * every receipt it already collected, and a failed workspace restore puts the
 * jj pointer back where it found it.
 */

const record = (
  overrides: Partial<EffectRecord> & Pick<EffectRecord, "id" | "kind" | "tier" | "seq">
): EffectRecord => ({
  status: "succeeded",
  runId: "run",
  lineageId: "run/root",
  durableBoundary: true,
  providerStream: false,
  ...overrides
})

const cache = (overrides: Partial<CacheStore.Service> = {}) =>
  Layer.succeed(CacheStore.CacheStore, CacheStore.makeNoop(overrides))

const hit: CacheStore.CacheEntry = {
  keyDigest: "digest",
  result: { ok: true },
  meta: {},
  createdAtMs: 0,
  recordedRunId: "run",
  recordedEventSeq: 1
}

const registryOf = (handlers: Parameters<typeof EffectHandlerRegistry.make>[0]) =>
  Layer.succeed(
    EffectHandlerRegistry.EffectHandlerRegistry,
    Effect.runSync(EffectHandlerRegistry.make(handlers))
  )

const jjOf = (overrides: Partial<Jj.Jj> = {}) => Layer.succeed(Jj.Jj, Jj.makeNoop(overrides))

describe("Compensation.assess", () => {
  it("blocks a sealed effect that never recorded a cache key", async () => {
    const plan = await Effect.runPromise(
      Compensation.assess([record({ id: "seal", kind: "read", tier: "sealed", seq: 1 })]).pipe(
        Effect.provide(cache()),
        Effect.provide(registryOf([]))
      )
    )

    expect(plan.assessments).toMatchObject([
      { classification: "blocking", reason: "The sealed effect has no content-addressed cache key." }
    ])
  })

  it("warns for a present sealed entry and blocks a missing one, in journal order", async () => {
    const plan = await Effect.runPromise(
      Compensation.assess([
        record({ id: "gone", kind: "read", tier: "sealed", seq: 2, cacheKey: "missing" }),
        record({ id: "kept", kind: "read", tier: "sealed", seq: 1, cacheKey: "digest" })
      ]).pipe(
        Effect.provide(
          cache({ get: (key) => Effect.succeed(key === "digest" ? Option.some(hit) : Option.none()) })
        ),
        Effect.provide(registryOf([]))
      )
    )

    expect(plan.effects.map((effect) => effect.id)).toEqual(["kept", "gone"])
    expect(plan.assessments.map((assessment) => assessment.classification)).toEqual([
      "warning",
      "blocking"
    ])
    expect(plan.assessments[1]?.reason).toBe("Sealed cache entry missing is missing.")
  })

  it("fails the whole preflight when the cache cannot be consulted", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        Compensation.assess([record({ id: "seal", kind: "read", tier: "sealed", seq: 1, cacheKey: "digest" })])
          .pipe(
            Effect.provide(
              cache({
                get: () => Effect.fail(new CacheStore.CacheStoreError({ code: "unknown", message: "cache down" }))
              })
            ),
            Effect.provide(registryOf([]))
          )
      )
    )

    expect(failure).toMatchObject({
      code: "unknown",
      message: "could not consult sealed result digest"
    })
  })

  it("blocks a compensable effect without a target pointer and reverts one with it", async () => {
    const effects = [record({ id: "write", kind: "fs", tier: "compensable", seq: 1 })]
    const without = await Effect.runPromise(
      Compensation.assess(effects).pipe(Effect.provide(cache()), Effect.provide(registryOf([])))
    )
    const withTarget = await Effect.runPromise(
      Compensation.assess(effects, "target").pipe(Effect.provide(cache()), Effect.provide(registryOf([])))
    )

    expect(without.assessments[0]).toMatchObject({
      classification: "blocking",
      reason: "The target frame has no recorded jj snapshot pointer."
    })
    expect(without.targetChangeId).toBeUndefined()
    expect(withTarget.assessments[0]).toMatchObject({
      classification: "revertible",
      reason: "The workspace will be restored to jj change target."
    })
    expect(withTarget.targetChangeId).toBe("target")
  })

  it("keeps a recorded residue on a blocking sealed assessment", async () => {
    const plan = await Effect.runPromise(
      Compensation.assess([
        record({ id: "seal", kind: "read", tier: "sealed", seq: 1, residue: "the model already answered" })
      ]).pipe(Effect.provide(cache()), Effect.provide(registryOf([])))
    )

    expect(plan.assessments[0]?.residue).toBe("the model already answered")
  })

  it("delegates an irreversible effect to its registered handler", async () => {
    const plan = await Effect.runPromise(
      Compensation.assess([record({ id: "send", kind: "send", tier: "irreversible", seq: 1 })]).pipe(
        Effect.provide(cache()),
        Effect.provide(
          registryOf([{
            kind: "send",
            tier: "irreversible",
            requiresIdempotencyKey: true,
            residue: () => "an email left the building",
            revert: () => Effect.succeed({ voided: true }),
            rollback: () => Effect.void
          }])
        )
      )
    )

    expect(plan.assessments[0]).toMatchObject({
      classification: "revertible",
      residue: "an email left the building"
    })
  })
})

describe("Compensation.compensate", () => {
  const irreversible = (id: string, seq: number) => record({ id, kind: "send", tier: "irreversible", seq })

  it("refuses to execute a plan that carries any blocking assessment", async () => {
    const plan = await Effect.runPromise(
      Compensation.assess([record({ id: "seal", kind: "read", tier: "sealed", seq: 1 })]).pipe(
        Effect.provide(cache()),
        Effect.provide(registryOf([]))
      )
    )
    const failure = await Effect.runPromise(
      Effect.flip(Compensation.compensate(plan).pipe(Effect.provide(registryOf([]))))
    )

    expect(failure).toMatchObject({
      code: "irreversible",
      message: "rewind is blocked by 1 crossed effect(s)"
    })
  })

  it("reverts in reverse journal order", async () => {
    const reverted: Array<string> = []
    const layer = registryOf([{
      kind: "send",
      tier: "irreversible",
      requiresIdempotencyKey: true,
      residue: () => "residue",
      revert: (effect) =>
        Effect.sync(() => {
          reverted.push(effect.id)
          return { voided: effect.id }
        }),
      rollback: () => Effect.void
    }])
    const plan = await Effect.runPromise(
      Compensation.assess([irreversible("first", 1), irreversible("second", 2)]).pipe(
        Effect.provide(cache()),
        Effect.provide(layer)
      )
    )

    const receipts = await Effect.runPromise(Compensation.compensate(plan).pipe(Effect.provide(layer)))

    expect(reverted).toEqual(["second", "first"])
    expect(receipts.map((receipt) => receipt.id)).toEqual(["second:rollback", "first:rollback"])
  })

  it("rolls back the receipts it already collected when a later revert fails", async () => {
    const rolledBack: Array<string> = []
    const layer = registryOf([{
      kind: "send",
      tier: "irreversible",
      requiresIdempotencyKey: true,
      residue: () => "residue",
      revert: (effect) =>
        effect.id === "first"
          ? Effect.fail(error("compensation_failed", "provider refused"))
          : Effect.succeed({ voided: effect.id }),
      rollback: (effect) =>
        Effect.sync(() => {
          rolledBack.push(effect.id)
        })
    }])
    const plan = await Effect.runPromise(
      Compensation.assess([irreversible("first", 1), irreversible("second", 2)]).pipe(
        Effect.provide(cache()),
        Effect.provide(layer)
      )
    )

    const failure = await Effect.runPromise(
      Effect.flip(Compensation.compensate(plan).pipe(Effect.provide(layer)))
    )

    expect(rolledBack).toEqual(["second"])
    expect(failure.code).toBe("compensation_failed")
    expect(failure.message).toContain("could not compensate first")
  })

  it("reports the rollback failure alongside the compensation failure", async () => {
    const layer = registryOf([{
      kind: "send",
      tier: "irreversible",
      requiresIdempotencyKey: true,
      residue: () => "residue",
      revert: (effect) =>
        effect.id === "first"
          ? Effect.fail(error("compensation_failed", "provider refused"))
          : Effect.succeed({ voided: effect.id }),
      rollback: () => Effect.fail(error("compensation_failed", "rollback refused"))
    }])
    const plan = await Effect.runPromise(
      Compensation.assess([irreversible("first", 1), irreversible("second", 2)]).pipe(
        Effect.provide(cache()),
        Effect.provide(layer)
      )
    )

    const failure = await Effect.runPromise(
      Effect.flip(Compensation.compensate(plan).pipe(Effect.provide(layer)))
    )

    expect(failure.cause).toMatchObject({ rollback: expect.anything() })
  })

  it("normalizes a non-Error compensation defect into the failure message", async () => {
    const layer = registryOf([{
      kind: "send",
      tier: "irreversible",
      requiresIdempotencyKey: true,
      residue: () => "residue",
      revert: () => Effect.die("provider-defect"),
      rollback: () => Effect.void
    }])
    const plan = await Effect.runPromise(
      Compensation.assess([irreversible("send", 1)]).pipe(
        Effect.provide(cache()),
        Effect.provide(layer)
      )
    )

    const failure = await Effect.runPromise(
      Effect.flip(Compensation.compensate(plan).pipe(Effect.provide(layer)))
    )

    expect(failure).toMatchObject({
      code: "compensation_failed",
      message: "could not compensate send: provider-defect"
    })
  })
})

describe("Compensation.restoreWorkspace", () => {
  const compensable = record({ id: "write", kind: "fs", tier: "compensable", seq: 1 })

  const planFor = (
    effects: ReadonlyArray<EffectRecord>,
    target?: string
  ) =>
    Effect.runPromise(
      Compensation.assess(effects, target).pipe(Effect.provide(cache()), Effect.provide(registryOf([])))
    )

  it("skips jj entirely when no compensable effect was crossed", async () => {
    let snapshots = 0
    const plan = await planFor([], "target")

    const result = await Effect.runPromise(
      Compensation.restoreWorkspace(plan, []).pipe(
        Effect.provide(registryOf([])),
        Effect.provide(
          jjOf({
            snapshot: () =>
              Effect.sync(() => {
                snapshots += 1
                return { changeId: "current" }
              })
          })
        )
      )
    )

    expect(snapshots).toBe(0)
    expect(result).toEqual({ handlerReceipts: [] })
  })

  it("restores the workspace to the target pointer and reports both change ids", async () => {
    let pointer = "current"
    const plan = await planFor([compensable], "target")

    const result = await Effect.runPromise(
      Compensation.restoreWorkspace(plan, []).pipe(
        Effect.provide(registryOf([])),
        Effect.provide(
          jjOf({
            snapshot: () => Effect.succeed({ changeId: pointer }),
            restore: (changeId: string) =>
              Effect.sync(() => {
                pointer = changeId
              })
          })
        )
      )
    )

    expect(pointer).toBe("target")
    expect(result.workspace).toEqual({ currentChangeId: "current", targetChangeId: "target" })
  })

  it("rolls handler receipts back when the pre-restore snapshot fails", async () => {
    const rolledBack: Array<string> = []
    const registry = registryOf([{
      kind: "send",
      tier: "irreversible",
      requiresIdempotencyKey: true,
      residue: () => "residue",
      revert: () => Effect.succeed({}),
      rollback: (effect) =>
        Effect.sync(() => {
          rolledBack.push(effect.id)
        })
    }])
    const plan = await planFor([compensable], "target")
    const receipt = {
      id: "send:rollback",
      effect: record({ id: "send", kind: "send", tier: "irreversible", seq: 2 }),
      data: {}
    }

    const failure = await Effect.runPromise(
      Effect.flip(
        Compensation.restoreWorkspace(plan, [receipt]).pipe(
          Effect.provide(registry),
          Effect.provide(jjOf({ snapshot: () => Effect.fail(jjError({ code: "not_installed", method: "snapshot" })) }))
        )
      )
    )

    expect(rolledBack).toEqual(["send"])
    expect(failure.message).toContain("could not snapshot current jj state")
  })

  it("reports a handler cleanup failure alongside a pre-restore snapshot failure", async () => {
    const registry = registryOf([{
      kind: "send",
      tier: "irreversible",
      requiresIdempotencyKey: true,
      residue: () => "residue",
      revert: () => Effect.succeed({}),
      rollback: () => Effect.fail(error("compensation_failed", "handler cleanup failed"))
    }])
    const plan = await planFor([compensable], "target")
    const receipt = {
      id: "send:rollback",
      effect: record({ id: "send", kind: "send", tier: "irreversible", seq: 2 }),
      data: {}
    }

    const failure = await Effect.runPromise(
      Effect.flip(
        Compensation.restoreWorkspace(plan, [receipt]).pipe(
          Effect.provide(registry),
          Effect.provide(jjOf({ snapshot: () => Effect.fail(jjError({ code: "not_installed", method: "snapshot" })) }))
        )
      )
    )

    expect(failure).toMatchObject({
      code: "compensation_failed",
      message: expect.stringContaining("could not snapshot current jj state"),
      cause: {
        snapshot: expect.anything(),
        handlerRollback: expect.anything()
      }
    })
  })

  it("restores the original pointer and the receipts when the target restore fails", async () => {
    const restores: Array<string> = []
    const rolledBack: Array<string> = []
    const registry = registryOf([{
      kind: "send",
      tier: "irreversible",
      requiresIdempotencyKey: true,
      residue: () => "residue",
      revert: () => Effect.succeed({}),
      rollback: (effect) =>
        Effect.sync(() => {
          rolledBack.push(effect.id)
        })
    }])
    const plan = await planFor([compensable], "target")
    const receipt = {
      id: "send:rollback",
      effect: record({ id: "send", kind: "send", tier: "irreversible", seq: 2 }),
      data: {}
    }

    const failure = await Effect.runPromise(
      Effect.flip(
        Compensation.restoreWorkspace(plan, [receipt]).pipe(
          Effect.provide(registry),
          Effect.provide(
            jjOf({
              snapshot: () => Effect.succeed({ changeId: "current" }),
              restore: (changeId: string) =>
                Effect.gen(function*() {
                  restores.push(changeId)
                  if (changeId === "target") {
                    return yield* Effect.fail(jjError({ code: "conflict", method: "restore" }))
                  }
                })
            })
          )
        )
      )
    )

    expect(restores).toEqual(["target", "current"])
    expect(rolledBack).toEqual(["send"])
    expect(failure.message).toContain("could not restore jj state target")
  })

  for (
    const faults of [
      { workspaceRollback: true, handlerRollback: false },
      { workspaceRollback: false, handlerRollback: true },
      { workspaceRollback: true, handlerRollback: true }
    ]
  ) {
    it(`reports target-restore cleanup failures (workspace=${faults.workspaceRollback}, handlers=${faults.handlerRollback})`, async () => {
      const registry = registryOf([{
        kind: "send",
        tier: "irreversible",
        requiresIdempotencyKey: true,
        residue: () => "residue",
        revert: () => Effect.succeed({}),
        rollback: () =>
          faults.handlerRollback
            ? Effect.fail(error("compensation_failed", "handler cleanup failed"))
            : Effect.void
      }])
      const plan = await planFor([compensable], "target")
      const receipt = {
        id: "send:rollback",
        effect: record({ id: "send", kind: "send", tier: "irreversible", seq: 2 }),
        data: {}
      }

      const failure = await Effect.runPromise(
        Effect.flip(
          Compensation.restoreWorkspace(plan, [receipt]).pipe(
            Effect.provide(registry),
            Effect.provide(
              jjOf({
                snapshot: () => Effect.succeed({ changeId: "current" }),
                restore: (changeId: string) =>
                  changeId === "target" || faults.workspaceRollback
                    ? Effect.fail(jjError({ code: "conflict", method: "restore" }))
                    : Effect.void
              })
            )
          )
        )
      )
      const cause = failure.cause as {
        readonly workspaceRollback?: unknown
        readonly handlerRollback?: unknown
      }

      expect(cause.workspaceRollback === undefined).toBe(!faults.workspaceRollback)
      expect(cause.handlerRollback === undefined).toBe(!faults.handlerRollback)
    })
  }

  it("refuses a plan that needs a restore but carries no resolved pointer", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        Compensation.restoreWorkspace({ effects: [compensable], assessments: [] }, []).pipe(
          Effect.provide(registryOf([])),
          Effect.provide(jjOf())
        )
      )
    )

    expect(failure).toMatchObject({
      code: "compensation_failed",
      message: "target jj pointer was not resolved during preflight"
    })
  })
})

describe("Compensation.execute", () => {
  it("compensates handlers first and then restores the workspace", async () => {
    const order: Array<string> = []
    const layer = registryOf([{
      kind: "send",
      tier: "irreversible",
      requiresIdempotencyKey: true,
      residue: () => "residue",
      revert: (effect) =>
        Effect.sync(() => {
          order.push(`revert:${effect.id}`)
          return {}
        }),
      rollback: () => Effect.void
    }])
    const plan = await Effect.runPromise(
      Compensation.assess(
        [
          record({ id: "write", kind: "fs", tier: "compensable", seq: 1 }),
          record({ id: "send", kind: "send", tier: "irreversible", seq: 2 })
        ],
        "target"
      ).pipe(Effect.provide(cache()), Effect.provide(layer))
    )

    const result = await Effect.runPromise(
      Compensation.execute(plan).pipe(
        Effect.provide(layer),
        Effect.provide(
          jjOf({
            snapshot: () => Effect.succeed({ changeId: "current" }),
            restore: (changeId: string) =>
              Effect.sync(() => {
                order.push(`jj:${changeId}`)
              })
          })
        )
      )
    )

    expect(order).toEqual(["revert:send", "jj:target"])
    expect(result.handlerReceipts.map((receipt) => receipt.id)).toEqual(["send:rollback"])
    expect(result.workspace).toEqual({ currentChangeId: "current", targetChangeId: "target" })
  })
})

describe("Compensation.rollback", () => {
  const receipt = {
    id: "send:rollback",
    effect: record({ id: "send", kind: "send", tier: "irreversible", seq: 2 }),
    data: {}
  }

  it("undoes the workspace pointer before the handler receipts", async () => {
    const order: Array<string> = []
    const registry = registryOf([{
      kind: "send",
      tier: "irreversible",
      requiresIdempotencyKey: true,
      residue: () => "residue",
      revert: () => Effect.succeed({}),
      rollback: () =>
        Effect.sync(() => {
          order.push("handler")
        })
    }])

    await Effect.runPromise(
      Compensation.rollback({
        handlerReceipts: [receipt],
        workspace: { currentChangeId: "current", targetChangeId: "target" }
      }).pipe(
        Effect.provide(registry),
        Effect.provide(
          jjOf({
            restore: (changeId: string) =>
              Effect.sync(() => {
                order.push(`jj:${changeId}`)
              })
          })
        )
      )
    )

    expect(order).toEqual(["jj:current", "handler"])
  })

  it("aggregates a failing workspace restore with a failing handler rollback", async () => {
    const registry = registryOf([{
      kind: "send",
      tier: "irreversible",
      requiresIdempotencyKey: true,
      residue: () => "residue",
      revert: () => Effect.succeed({}),
      rollback: () => Effect.fail(error("compensation_failed", "handler refused"))
    }])

    const failure = await Effect.runPromise(
      Effect.flip(
        Compensation.rollback({
          handlerReceipts: [receipt],
          workspace: { currentChangeId: "current", targetChangeId: "target" }
        }).pipe(
          Effect.provide(registry),
          Effect.provide(jjOf({ restore: () => Effect.fail(jjError({ code: "conflict", method: "restore" })) }))
        )
      )
    )

    expect(failure).toMatchObject({
      code: "compensation_failed",
      message: "2 rewind rollback operation(s) failed"
    })
  })
})

describe("Compensation.toStoreReceipts", () => {
  it("namespaces every receipt under its audit for atomic archival", () => {
    const receipts = Compensation.toStoreReceipts("audit-1", {
      handlerReceipts: [{
        id: "send:rollback",
        effect: record({ id: "send", kind: "send", tier: "irreversible", seq: 2 }),
        data: { voided: true }
      }]
    })

    expect(receipts).toEqual([{
      id: "audit-1:send:rollback",
      auditId: "audit-1",
      effectId: "send",
      receipt: expect.objectContaining({ id: "send:rollback" })
    }])
  })
})
