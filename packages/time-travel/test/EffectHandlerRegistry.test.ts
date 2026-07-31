import * as Journal from "@smithers/journal/Journal"
import type * as JournalEvent from "@smithers/journal/JournalEvent"
import * as Effect from "effect/Effect"
import * as HashMap from "effect/HashMap"
import * as Layer from "effect/Layer"
import { describe, expect, it } from "vitest"
import * as EffectBoundary from "../src/EffectBoundary.ts"
import type { EffectRecord } from "../src/EffectBoundary.ts"
import * as EffectHandlerRegistry from "../src/EffectHandlerRegistry.ts"

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
    expect(updated.resolve("mail.send")).toBeDefined()
    expect(HashMap.size(original.handlers)).toBe(0)
    expect(HashMap.size(updated.handlers)).toBe(1)
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
    expect(emitted[1]?.meta).toMatchObject({
      adapter: "mail",
      lineageId: "run/root",
      timeTravel: {
        effectId: "effect-boundary",
        status: "succeeded"
      }
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
})
