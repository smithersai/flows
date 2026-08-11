import { Effect, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Journal from "../src/Journal.ts"
import type { Input, RunId } from "../src/JournalEvent.ts"
import * as OwnerId from "../src/OwnerId.ts"
import * as Projection from "../src/Projection.ts"

describe("service contracts", () => {
  it("constructs and exercises the closed Journal service", async () => {
    const implementation = Journal.makeNoop()
    expect(Journal.make(implementation)).toBe(implementation)

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const input = {} as Input
      expect((yield* Effect.flip(implementation.emitLossy(input))).code).toBe("journal_closed")
      expect((yield* Effect.flip(implementation.emitDurable(input))).code).toBe("journal_closed")
      expect(
        (yield* Effect.flip(implementation.entries({
          runId: "run" as RunId,
          limit: 1
        }))).code
      ).toBe("journal_closed")
      expect(
        (yield* Stream.runHead(implementation.stream({
          runId: "run" as RunId
        })).pipe(Effect.flip)).code
      ).toBe("journal_closed")
      expect(
        (yield* Stream.runHead(implementation.project(
          Projection.make({
            name: "noop",
            initial: 0,
            reduce: (state) => Effect.succeed(state)
          }),
          { runId: "run" as RunId }
        )).pipe(Effect.flip)).code
      ).toBe("journal_closed")
      expect((yield* Effect.flip(implementation.flush)).code).toBe("journal_closed")
      yield* implementation.changes
    })))

    const overridden = await Effect.runPromise(
      Effect.gen(function*() {
        const service = yield* Journal.Journal
        yield* service.flush
        return service
      }).pipe(Effect.provide(Journal.layerNoop({ flush: Effect.void })))
    )
    expect(overridden.flush).toBe(Effect.void)
  })

  it("decodes the fencing token the durable channel accepts", () => {
    const owner: OwnerId.OwnerId = { hostId: "host", pid: 1, nonce: "nonce" }
    expect(Schema.decodeUnknownSync(OwnerId.OwnerId)(owner)).toEqual(owner)
    expect(() => Schema.decodeUnknownSync(OwnerId.OwnerId)({ ...owner, pid: "1" })).toThrow()
  })
})
