import * as Journal from "@smithers/journal/Journal"
import type * as JournalEvent from "@smithers/journal/JournalEvent"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as HashMap from "effect/HashMap"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import { describe, expect, it } from "vitest"
import * as EffectBoundary from "../src/EffectBoundary.ts"
import type { EffectRecord } from "../src/EffectBoundary.ts"
import * as EffectHandlerRegistry from "../src/EffectHandlerRegistry.ts"
import { error } from "../src/TimeTravelError.ts"

const crossed = (
  status: EffectRecord["status"] = "succeeded"
): EffectRecord => ({
  id: "effect-1",
  kind: "mail.send",
  tier: "irreversible",
  status,
  runId: "run",
  lineageId: "run/root",
  seq: 4,
  input: { to: "person@example.com" },
  residue: "the recipient may retain the message",
  durableBoundary: true,
  providerStream: false
})

const handler = (
  events: Array<string> = []
): EffectHandlerRegistry.Handler => ({
  kind: "mail.send",
  tier: "irreversible",
  requiresIdempotencyKey: true,
  residue: (effect) => effect.residue ?? "mail residue",
  revert: (effect) =>
    Effect.sync(() => {
      events.push(`revert:${effect.id}`)
      return { messageId: "message-1" }
    }),
  rollback: (effect, receipt) =>
    Effect.sync(() => {
      events.push(`rollback:${effect.id}:${String((receipt as { readonly messageId: string }).messageId)}`)
    })
})

describe("EffectHandlerRegistry", () => {
  it("preserves the original activity failure when recording its intended boundary fails", async () => {
    const journal = Journal.makeNoop({
      emit: () => Effect.fail(new Journal.JournalError({ code: "unknown", message: "journal offline" }))
    })
    const failure = await Effect.runPromise(
      Effect.flip(
        EffectBoundary.guard({
          id: "emit-failure",
          kind: "mail.send",
          tier: "irreversible",
          runId: "run",
          lineageId: "run/root",
          sourceId: "adapter",
          metadata: "legacy metadata"
        }, Effect.succeed("never")).pipe(Effect.provide(Layer.succeed(Journal.Journal, journal)))
      )
    )

    expect(failure).toMatchObject({
      code: "unknown",
      message: "could not record intended boundary for effect emit-failure"
    })
  })

  it("decodes only complete boundary records and retains every supported optional field", () => {
    const valid = (overrides: Record<string, unknown> = {}): JournalEvent.Entry => ({
      runId: "run" as JournalEvent.RunId,
      seq: 4 as JournalEvent.Seq,
      eventId: "event",
      sourceId: "source" as JournalEvent.SourceId,
      sourceSeq: 0 as JournalEvent.SourceSeq,
      emittedAtMs: 0,
      eventType: EffectBoundary.eventType,
      payload: {
        effect: {
          id: "effect",
          kind: "mail.send",
          tier: "irreversible",
          status: "succeeded",
          runId: "run",
          lineageId: "run/root",
          input: null,
          output: 0,
          cacheKey: "cache",
          changeId: "change",
          idempotencyKey: "key",
          residue: "residue",
          durableBoundary: false,
          providerStream: true,
          attempt: 0,
          nonce: "nonce",
          ...overrides
        }
      },
      meta: {}
    })
    const decoded = EffectBoundary.fromEntry(valid())

    expect(decoded).toEqual({
      id: "effect",
      kind: "mail.send",
      tier: "irreversible",
      status: "succeeded",
      runId: "run",
      lineageId: "run/root",
      seq: 4,
      input: null,
      output: 0,
      cacheKey: "cache",
      changeId: "change",
      idempotencyKey: "key",
      residue: "residue",
      durableBoundary: false,
      providerStream: true,
      attempt: 0,
      nonce: "nonce"
    })
    for (const tier of ["sealed", "compensable", "irreversible"] as const) {
      for (const status of ["intended", "succeeded", "unknown"] as const) {
        expect(EffectBoundary.fromEntry(valid({ tier, status }))).toMatchObject({ tier, status })
      }
    }
    for (const payload of [null, [], {}, { effect: null }, { effect: {} }]) {
      expect(EffectBoundary.fromEntry({ ...valid(), payload })).toBeUndefined()
    }
    for (
      const [field, value] of Object.entries({ id: 1, kind: 1, tier: "bad", status: "bad", runId: 1, lineageId: 1 })
    ) {
      expect(EffectBoundary.fromEntry(valid({ [field]: value }))).toBeUndefined()
    }
    expect(EffectBoundary.fromEntry({ ...valid(), eventType: "other" })).toBeUndefined()
  })

  it("uses durable defaults and folds the latest boundary evidence in sequence order", () => {
    const entry = (seq: number, id: string, status: EffectBoundary.EffectStatus): JournalEvent.Entry => ({
      runId: "run" as JournalEvent.RunId,
      seq: seq as JournalEvent.Seq,
      eventId: String(seq),
      sourceId: "source" as JournalEvent.SourceId,
      sourceSeq: seq as JournalEvent.SourceSeq,
      emittedAtMs: 0,
      eventType: EffectBoundary.eventType,
      payload: { effect: { id, kind: "kind", tier: "sealed", status, runId: "run", lineageId: "run/root" } },
      meta: {}
    })
    expect(EffectBoundary.fromEntry(entry(1, "a", "intended"))).toMatchObject({
      durableBoundary: true,
      providerStream: false
    })
    expect(
      EffectBoundary.fromEntries([
        { ...entry(1, "ignored", "intended"), eventType: "other" },
        entry(3, "a", "unknown"),
        entry(2, "b", "succeeded"),
        entry(4, "a", "succeeded")
      ])
    )
      .toEqual([
        expect.objectContaining({ id: "b", seq: 2 }),
        expect.objectContaining({ id: "a", seq: 4, status: "succeeded" })
      ])
  })
  it("rejects duplicate stable effect kinds before exposing a registry", () => {
    const failure = Effect.runSync(
      Effect.flip(EffectHandlerRegistry.make([handler(), handler()]))
    )

    expect(failure.code).toBe("unknown")
    expect(failure.message).toContain("already registered")
  })

  it("registration returns a new immutable registry", () => {
    const original = EffectHandlerRegistry.makeNoop()
    const updated = Effect.runSync(original.register(handler()))

    expect(original.resolve("mail.send")).toBeUndefined()
    expect(updated.resolve("mail.send")).toMatchObject({
      kind: "mail.send",
      tier: "irreversible",
      requiresIdempotencyKey: true
    })
    expect(HashMap.size(original.handlers)).toBe(0)
    expect(HashMap.size(updated.handlers)).toBe(1)
  })

  it("rejects a duplicate registration on an existing immutable registry", () => {
    const registry = Effect.runSync(EffectHandlerRegistry.make([handler()]))
    const failure = Effect.runSync(Effect.flip(registry.register(handler())))

    expect(failure).toMatchObject({
      code: "unknown",
      message: "effect handler mail.send is already registered"
    })
    expect(HashMap.size(registry.handlers)).toBe(1)
  })

  it("blocks unknown completion state with residue disclosure", () => {
    const registry = Effect.runSync(EffectHandlerRegistry.make([handler()]))
    const assessment = Effect.runSync(registry.assess(crossed("unknown")))

    expect(assessment).toEqual({
      classification: "blocking",
      reason: "Effect effect-1 has unknown completion state.",
      residue: "the recipient may retain the message"
    })
  })

  it("blocks intended completion evidence before a handler can compensate it", () => {
    const registry = Effect.runSync(EffectHandlerRegistry.make([handler()]))

    expect(Effect.runSync(registry.assess(crossed("intended")))).toEqual({
      classification: "blocking",
      reason: "Effect effect-1 has intended completion state.",
      residue: "the recipient may retain the message"
    })
  })

  it("blocks an unregistered effect kind and discloses its recorded residue", () => {
    const registry = EffectHandlerRegistry.makeNoop()
    const assessment = Effect.runSync(registry.assess(crossed()))

    expect(assessment).toEqual({
      classification: "blocking",
      reason: "No compensation handler is registered for mail.send.",
      residue: "the recipient may retain the message"
    })
  })

  it("falls back to a generic residue when the effect recorded none", () => {
    const registry = EffectHandlerRegistry.makeNoop()
    const assessment = Effect.runSync(
      registry.assess({ ...crossed(), residue: undefined })
    )

    expect(assessment.residue).toBe("The mail.send effect remains outside the journal.")
  })

  it("blocks an effect whose handler is registered for a different tier", () => {
    const registry = Effect.runSync(EffectHandlerRegistry.make([handler()]))
    const assessment = Effect.runSync(
      registry.assess({ ...crossed(), tier: "compensable" })
    )

    expect(assessment).toMatchObject({
      classification: "blocking",
      reason: "Handler mail.send is registered for irreversible, not compensable."
    })
  })

  it("prefers a handler's own assessment over the default verdict", () => {
    const registry = Effect.runSync(
      EffectHandlerRegistry.make([{
        ...handler(),
        assess: () =>
          Effect.succeed({
            classification: "warning" as const,
            reason: "the provider deduplicates by idempotency key",
            residue: "a duplicate send is a no-op"
          })
      }])
    )

    expect(Effect.runSync(registry.assess(crossed()))).toEqual({
      classification: "warning",
      reason: "the provider deduplicates by idempotency key",
      residue: "a duplicate send is a no-op"
    })
  })

  it("preserves a typed failure from a handler's custom assessment", () => {
    const registry = Effect.runSync(
      EffectHandlerRegistry.make([{
        ...handler(),
        assess: () => Effect.fail(error("unknown", "provider preflight unavailable"))
      }])
    )

    expect(Effect.runSync(Effect.flip(registry.assess(crossed())))).toMatchObject({
      code: "unknown",
      message: "provider preflight unavailable"
    })
  })

  it("fails revert and rollback for an unregistered effect kind", () => {
    const registry = EffectHandlerRegistry.makeNoop()
    const revertFailure = Effect.runSync(Effect.flip(registry.revert(crossed())))
    const rollbackFailure = Effect.runSync(
      Effect.flip(registry.rollback({ id: "effect-1:rollback", effect: crossed(), data: {} }))
    )

    for (const failure of [revertFailure, rollbackFailure]) {
      expect(failure).toMatchObject({
        code: "irreversible",
        message: "no compensation handler is registered for effect kind mail.send"
      })
    }
  })

  it("refuses to revert through a handler registered for another tier", () => {
    const registry = Effect.runSync(EffectHandlerRegistry.make([handler()]))
    const failure = Effect.runSync(
      Effect.flip(registry.revert({ ...crossed(), tier: "compensable" }))
    )

    expect(failure).toMatchObject({
      code: "irreversible",
      message: "handler mail.send cannot compensate compensable effect effect-1"
    })
  })

  it("normalises handler revert and rollback failures into typed compensation errors", () => {
    const registry = Effect.runSync(
      EffectHandlerRegistry.make([{
        ...handler(),
        revert: () => Effect.fail(error("unknown", "provider timeout")),
        rollback: () => Effect.fail(error("unknown", "provider timeout"))
      }])
    )

    expect(Effect.runSync(Effect.flip(registry.revert(crossed())))).toMatchObject({
      code: "compensation_failed",
      message: "handler mail.send could not revert effect-1"
    })
    expect(
      Effect.runSync(
        Effect.flip(registry.rollback({ id: "effect-1:rollback", effect: crossed(), data: {} }))
      )
    ).toMatchObject({
      code: "compensation_failed",
      message: "handler mail.send could not roll back compensation for effect-1"
    })
  })

  it("returns a durable rollback receipt and dispatches it to the same handler", () => {
    const events: Array<string> = []
    const registry = Effect.runSync(EffectHandlerRegistry.make([handler(events)]))
    const receipt = Effect.runSync(registry.revert(crossed()))
    Effect.runSync(registry.rollback(receipt))

    expect(receipt).toMatchObject({
      id: "effect-1:rollback",
      effect: { id: "effect-1", kind: "mail.send" },
      data: { messageId: "message-1" }
    })
    expect(events).toEqual([
      "revert:effect-1",
      "rollback:effect-1:message-1"
    ])
  })

  it("provides tier and idempotency metadata through a Layer", async () => {
    const resolved = await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* EffectHandlerRegistry.EffectHandlerRegistry
        return registry.resolve("mail.send")
      }).pipe(
        Effect.provide(EffectHandlerRegistry.layer([handler()]))
      )
    )

    expect(resolved).toMatchObject({
      kind: "mail.send",
      tier: "irreversible",
      requiresIdempotencyKey: true
    })
  })

  it("records intended and succeeded boundary states with additive metadata", async () => {
    const emitted: Array<JournalEvent.Input> = []
    const journal = Journal.makeNoop({
      emit: (input) =>
        Effect.sync(() => {
          emitted.push(input)
          return {
            _tag: "Accepted" as const,
            seq: emitted.length as JournalEvent.Seq,
            sourceSeq: emitted.length as JournalEvent.SourceSeq
          }
        })
    })
    const result = await Effect.runPromise(
      EffectBoundary.guard({
        id: "effect-boundary",
        kind: "mail.send",
        tier: "irreversible",
        runId: "run",
        lineageId: "run/root",
        sourceId: "adapter",
        sourceSeq: 10,
        cacheKey: "mail-cache-key",
        metadata: { adapter: "mail" }
      }, Effect.succeed("sent")).pipe(
        Effect.provide(Layer.succeed(Journal.Journal, journal))
      )
    )

    expect(result).toBe("sent")
    expect(emitted.map((input) =>
      (input.payload as {
        readonly effect: { readonly status: string }
      }).effect.status
    )).toEqual(["intended", "succeeded"])
    expect(emitted.map((input) => input.sourceSeq)).toEqual([10, 11])
    expect(emitted[1]?.payload).toMatchObject({
      effect: {
        id: "effect-boundary",
        output: "sent",
        durableBoundary: true,
        providerStream: false
      }
    })
    expect(emitted[1]?.meta).toMatchObject({
      adapter: "mail",
      lineageId: "run/root",
      cacheKey: "mail-cache-key",
      timeTravel: {
        effectId: "effect-boundary",
        status: "succeeded"
      }
    })
  })

  it("reports a succeeded-boundary persistence failure after the activity has completed", async () => {
    let activityRuns = 0
    let emits = 0
    const journal = Journal.makeNoop({
      emit: () =>
        Effect.suspend(() => {
          emits += 1
          return emits === 1
            ? Effect.succeed({
              _tag: "Accepted" as const,
              seq: 1 as JournalEvent.Seq,
              sourceSeq: 1 as JournalEvent.SourceSeq
            })
            : Effect.fail(new Journal.JournalError({ code: "unknown", message: "terminal journal failure" }))
        })
    })

    const failure = await Effect.runPromise(
      Effect.flip(
        EffectBoundary.guard({
          id: "terminal-success-failure",
          kind: "mail.send",
          tier: "irreversible",
          runId: "run",
          lineageId: "run/root",
          sourceId: "adapter"
        }, Effect.sync(() => ++activityRuns)).pipe(
          Effect.provide(Layer.succeed(Journal.Journal, journal))
        )
      )
    )

    expect(activityRuns).toBe(1)
    expect(emits).toBe(2)
    expect(failure).toMatchObject({
      code: "unknown",
      message: "could not record succeeded boundary for effect terminal-success-failure"
    })
  })

  it("records unknown and preserves the original activity failure", async () => {
    const emitted: Array<JournalEvent.Input> = []
    const journal = Journal.makeNoop({
      emit: (input) =>
        Effect.sync(() => {
          emitted.push(input)
          return {
            _tag: "Accepted" as const,
            seq: emitted.length as JournalEvent.Seq,
            sourceSeq: emitted.length as JournalEvent.SourceSeq
          }
        })
    })
    const failure = await Effect.runPromise(
      Effect.flip(
        EffectBoundary.guard({
          id: "effect-failed",
          kind: "mail.send",
          tier: "irreversible",
          runId: "run",
          lineageId: "run/root",
          sourceId: "adapter"
        }, Effect.fail("activity-failed")).pipe(
          Effect.provide(Layer.succeed(Journal.Journal, journal))
        )
      )
    )

    expect(failure).toBe("activity-failed")
    expect(emitted.map((input) =>
      (input.payload as {
        readonly effect: { readonly status: string }
      }).effect.status
    )).toEqual(["intended", "unknown"])
  })

  it("records unknown and preserves an activity defect as a defect", async () => {
    const emitted: Array<string> = []
    const journal = Journal.makeNoop({
      emit: (input) =>
        Effect.sync(() => {
          emitted.push((input.payload as { readonly effect: { readonly status: string } }).effect.status)
          return {
            _tag: "Accepted" as const,
            seq: emitted.length as JournalEvent.Seq,
            sourceSeq: emitted.length as JournalEvent.SourceSeq
          }
        })
    })

    const exit = await Effect.runPromise(
      Effect.exit(
        EffectBoundary.guard({
          id: "effect-defect",
          kind: "mail.send",
          tier: "irreversible",
          runId: "run",
          lineageId: "run/root",
          sourceId: "adapter"
        }, Effect.die("activity-defect")).pipe(
          Effect.provide(Layer.succeed(Journal.Journal, journal))
        )
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const defect = Cause.findDefect(exit.cause)
      expect(Result.isSuccess(defect) ? defect.success : undefined).toBe("activity-defect")
    }
    expect(emitted).toEqual(["intended", "unknown"])
  })

  it("preserves an activity failure when recording its unknown boundary also fails", async () => {
    let emits = 0
    const journal = Journal.makeNoop({
      emit: () =>
        Effect.suspend(() => {
          emits += 1
          return emits === 2
            ? Effect.fail(new Journal.JournalError({ code: "unknown", message: "terminal journal failure" }))
            : Effect.succeed({
              _tag: "Accepted" as const,
              seq: emits as JournalEvent.Seq,
              sourceSeq: emits as JournalEvent.SourceSeq
            })
        })
    })

    const failure = await Effect.runPromise(
      Effect.flip(
        EffectBoundary.guard({
          id: "terminal-emit-failure",
          kind: "mail.send",
          tier: "irreversible",
          runId: "run",
          lineageId: "run/root",
          sourceId: "adapter"
        }, Effect.fail("activity-failed")).pipe(Effect.provide(Layer.succeed(Journal.Journal, journal)))
      )
    )

    expect(failure).toBe("activity-failed")
    expect(emits).toBe(2)
  })

  it("settles an interrupted activity as unknown before the fiber exits", async () => {
    const emitted: Array<string> = []
    const entered = Effect.runSync(Deferred.make<void>())
    const journal = Journal.makeNoop({
      emit: (input) =>
        Effect.sync(() => {
          emitted.push((input.payload as { readonly effect: { readonly status: string } }).effect.status)
          return {
            _tag: "Accepted" as const,
            seq: emitted.length as JournalEvent.Seq,
            sourceSeq: emitted.length as JournalEvent.SourceSeq
          }
        })
    })
    const fiber = Effect.runFork(
      EffectBoundary.guard({
        id: "interrupted",
        kind: "mail.send",
        tier: "irreversible",
        runId: "run",
        lineageId: "run/root",
        sourceId: "adapter"
      }, Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))).pipe(
        Effect.provide(Layer.succeed(Journal.Journal, journal))
      )
    )

    await Effect.runPromise(Deferred.await(entered))
    await Effect.runPromise(Fiber.interrupt(fiber))
    const exit = await Effect.runPromise(Fiber.await(fiber))

    expect(exit._tag).toBe("Failure")
    expect(emitted).toEqual(["intended", "unknown"])
  })
})
