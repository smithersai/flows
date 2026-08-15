/**
 * Flow declarations are runtime contracts, including for handlers registered
 * directly with the engine rather than through the body interpreter.
 */
import { describe, expect, it } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow-next"
import { Node } from "@smthrs/plan-next"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"
import { layerDurable, makeLog } from "./DurableLogEngine.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it.effect(name, () => withCrypto(body()))

const InvalidSuccess = Flow.make("SchemaBoundary/invalid-success", {
  payload: {},
  success: Schema.String,
  body: () => Node.succeed("unused")
})

const InvalidFailure = Flow.make("SchemaBoundary/invalid-failure", {
  payload: {},
  success: Schema.String,
  error: Schema.Never,
  body: () => Node.succeed("unused")
})

const layers = (): ReadonlyArray<readonly [string, Layer.Layer<FlowRuntime.FlowRuntime>]> => [
  ["memory", FlowEngine.layerMemory],
  ["durable", layerDurable(makeLog())]
]

const assertDefect = (exit: Exit.Exit<unknown, unknown>): void => {
  expect(Exit.isFailure(exit)).toBe(true)
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
}

describe("flow schema boundary", () => {
  for (const [runtime, layer] of layers()) {
    effect(`${runtime} rejects a success outside the declared schema`, () =>
      Effect.gen(function*() {
        const exit = yield* Effect.scoped(Effect.gen(function*() {
          const engine = yield* FlowRuntime.FlowRuntime
          yield* engine.register(
            InvalidSuccess,
            () => Effect.succeed(42 as unknown as string)
          )
          return yield* Effect.exit(
            InvalidSuccess.execute({}, { executionId: `${runtime}-invalid-success` })
          )
        })).pipe(Effect.provide(layer))

        assertDefect(exit)
      }))

    effect(`${runtime} rejects a failure outside the declared schema`, () =>
      Effect.gen(function*() {
        const exit = yield* Effect.scoped(Effect.gen(function*() {
          const engine = yield* FlowRuntime.FlowRuntime
          yield* engine.register(
            InvalidFailure,
            () => Effect.fail("outside-contract" as never)
          )
          return yield* Effect.exit(
            InvalidFailure.execute({}, { executionId: `${runtime}-invalid-failure` })
          )
        })).pipe(Effect.provide(layer))

        assertDefect(exit)
      }))

    effect(`${runtime} exposes only schema-valid completion values through poll`, () =>
      Effect.gen(function*() {
        const polled = yield* Effect.scoped(Effect.gen(function*() {
          const engine = yield* FlowRuntime.FlowRuntime
          yield* engine.register(
            InvalidSuccess,
            () => Effect.succeed(42 as unknown as string)
          )
          const executionId = yield* InvalidSuccess.execute(
            {},
            { discard: true, executionId: `${runtime}-invalid-poll` }
          )
          let result = yield* InvalidSuccess.poll(executionId)
          for (let index = 0; index < 100 && Option.isNone(result); index++) {
            yield* Effect.yieldNow
            result = yield* InvalidSuccess.poll(executionId)
          }
          return result
        })).pipe(Effect.provide(layer))

        expect(Option.isSome(polled)).toBe(true)
        if (Option.isSome(polled)) {
          expect(polled.value._tag).toBe("Complete")
          if (polled.value._tag === "Complete") assertDefect(polled.value.exit)
        }
      }))
  }
})
