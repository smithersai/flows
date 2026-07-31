import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { DurableDeferred, Flow, FlowEngine } from "../src/index.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, never>) =>
  it(name, () => Effect.runPromise(body()))

const Gate = DurableDeferred.make("DurableDeferred/Gate", {
  success: Schema.String,
  error: Schema.String
})

const makeFlow = (tag: string, body: Effect.Effect<any, any, any>) => {
  const flow = Flow.make(tag, {
    payload: { id: Schema.String },
    success: Schema.String,
    error: Schema.String,
    idempotencyKey: ({ id }) => id
  })
  return {
    flow,
    layer: flow.toLayer(() => body).pipe(Layer.provideMerge(FlowEngine.layerMemory))
  }
}

const completeToken = <S extends Schema.Constraint, E extends Schema.Constraint>(
  deferred: DurableDeferred.DurableDeferred<S, E>,
  flow: Flow.Any,
  executionId: string
) =>
  Effect.sync(() =>
    DurableDeferred.tokenFromExecutionId(deferred, { flow, executionId })
  )

describe("DurableDeferred", () => {
  effect("tokens round-trip through their base64url encoding", () =>
    Effect.sync(() => {
      const token = new DurableDeferred.TokenParsed({
        flowName: "Some/Flow",
        executionId: "exec-1",
        deferredName: "Gate"
      }).asToken
      const parsed = DurableDeferred.TokenParsed.fromString(token)
      expect(parsed.flowName).toBe("Some/Flow")
      expect(parsed.executionId).toBe("exec-1")
      expect(parsed.deferredName).toBe("Gate")
      expect(DurableDeferred.TokenParsed.encode(parsed)).toBe(token)
    }))

  effect("tokenFromPayload derives the same token as the running instance", () => {
    const flow = Flow.make("DurableDeferred/token-payload", {
      payload: { id: Schema.String },
      success: Schema.Void,
      idempotencyKey: ({ id }) => id
    })
    return Effect.gen(function*() {
      const executionId = yield* flow.executionId({ id: "abc" })
      const fromPayload = yield* DurableDeferred.tokenFromPayload(Gate, {
        flow,
        payload: { id: "abc" }
      })
      const fromInstance = yield* DurableDeferred.token(Gate).pipe(
        Effect.provideService(
          FlowEngine.FlowInstance,
          FlowEngine.FlowInstance.initial(flow, executionId)
        )
      )
      expect(fromPayload).toBe(fromInstance)
      expect(DurableDeferred.TokenParsed.fromString(fromPayload).deferredName).toBe(Gate.name)
    })
  })

  effect("awaiting an unresolved deferred suspends the flow until it succeeds", () => {
    const { flow, layer } = makeFlow(
      "DurableDeferred/await-success",
      Effect.map(DurableDeferred.await(Gate), (value) => `got:${value}`)
    )
    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "s" }, { discard: true })
      const suspended = yield* flow.poll(executionId)
      expect(Option.isSome(suspended) && suspended.value._tag).toBe("Suspended")

      const token = yield* completeToken(Gate, flow, executionId)
      yield* DurableDeferred.succeed(Gate, { token, value: "hello" })

      const result = yield* flow.poll(executionId)
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toBe("got:hello")
      }
    }).pipe(Effect.provide(layer))
  })

  effect("a deferred failure propagates as a typed flow failure", () => {
    const { flow, layer } = makeFlow(
      "DurableDeferred/await-fail",
      DurableDeferred.await(Gate)
    )
    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "f" }, { discard: true })
      const token = yield* completeToken(Gate, flow, executionId)
      yield* DurableDeferred.fail(Gate, { token, error: "boom" })

      const result = yield* flow.poll(executionId)
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isFailure(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isFailure(result.value.exit)) {
        expect(result.value.exit.cause.reasons.find(Cause.isFailReason)?.error).toBe("boom")
      }
    }).pipe(Effect.provide(layer))
  })

  effect("a deferred failure can be handled inside the flow", () => {
    const { flow, layer } = makeFlow(
      "DurableDeferred/await-handled",
      DurableDeferred.await(Gate).pipe(
        Effect.catch((error) => Effect.succeed(`recovered:${error}`))
      )
    )
    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "h" }, { discard: true })
      const token = yield* completeToken(Gate, flow, executionId)
      yield* DurableDeferred.fail(Gate, { token, error: "boom" })

      const result = yield* flow.poll(executionId)
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toBe("recovered:boom")
      }
    }).pipe(Effect.provide(layer))
  })

  effect("a deferred defect propagates as a die cause", () => {
    const { flow, layer } = makeFlow(
      "DurableDeferred/await-defect",
      DurableDeferred.await(Gate)
    )
    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "d" }, { discard: true })
      const token = yield* completeToken(Gate, flow, executionId)
      yield* DurableDeferred.failCause(Gate, {
        token,
        cause: Cause.die("defective")
      })

      const result = yield* flow.poll(executionId)
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isFailure(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isFailure(result.value.exit)) {
        expect(result.value.exit.cause.reasons.some(Cause.isDieReason)).toBe(true)
      }
    }).pipe(Effect.provide(layer))
  })

  effect("the first completion wins and later completions are ignored", () => {
    const { flow, layer } = makeFlow(
      "DurableDeferred/first-wins",
      Effect.map(DurableDeferred.await(Gate), (value) => `got:${value}`)
    )
    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "w" }, { discard: true })
      const token = yield* completeToken(Gate, flow, executionId)
      yield* DurableDeferred.succeed(Gate, { token, value: "first" })
      // a divergent duplicate completion must not overwrite the winner
      yield* DurableDeferred.succeed(Gate, { token, value: "second" })
      yield* DurableDeferred.fail(Gate, { token, error: "late-failure" })

      const result = yield* flow.poll(executionId)
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toBe("got:first")
      }
    }).pipe(Effect.provide(layer))
  })

  effect("a completion recorded before the flow awaits is redelivered", () => {
    const { flow, layer } = makeFlow(
      "DurableDeferred/early-completion",
      Effect.map(DurableDeferred.await(Gate), (value) => `got:${value}`)
    )
    return Effect.gen(function*() {
      // complete the deferred before the execution ever starts
      const executionId = yield* flow.executionId({ id: "e" })
      const token = DurableDeferred.tokenFromExecutionId(Gate, { flow, executionId })
      yield* DurableDeferred.succeed(Gate, { token, value: "early" })

      const value = yield* flow.execute({ id: "e" })
      expect(value).toBe("got:early")
    }).pipe(Effect.provide(layer))
  })

  effect("into records the effect exit so a replay reuses it without re-running", () => {
    let runs = 0
    const Recorded = DurableDeferred.make("DurableDeferred/Recorded", {
      success: Schema.Number,
      error: Schema.String
    })
    const flow = Flow.make("DurableDeferred/into", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String,
      idempotencyKey: ({ id }) => id
    })
    const layer = flow.toLayer(() =>
      Effect.gen(function*() {
        const engine = yield* FlowEngine.FlowEngine
        const first = yield* DurableDeferred.into(
          Effect.sync(() => ++runs),
          Recorded
        )
        const persisted = yield* engine.deferredResult(Recorded)
        expect(Option.isSome(persisted)).toBe(true)
        const second = yield* DurableDeferred.into(
          Effect.sync(() => ++runs),
          Recorded
        )
        return first + second
      })
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
    return Effect.gen(function*() {
      // `into` writes the exit once; the recorded exit is what a resumed flow reads
      expect(yield* flow.execute({ id: "i" })).toBe(3)
      expect(runs).toBe(2)
    }).pipe(Effect.provide(layer))
  })

  effect("raceAll returns the first result and replays it from the persisted exit", () => {
    let attempts = 0
    const flow = Flow.make("DurableDeferred/raceAll", {
      payload: { id: Schema.String },
      success: Schema.String,
      error: Schema.String,
      idempotencyKey: ({ id }) => id
    })
    const race = DurableDeferred.raceAll({
      name: "race",
      success: Schema.String,
      error: Schema.String,
      effects: [
        Effect.sync(() => {
          attempts++
          return "fast"
        }),
        Effect.never as Effect.Effect<string, string>
      ]
    })
    const layer = flow.toLayer(() =>
      Effect.gen(function*() {
        const first = yield* race
        const second = yield* race
        return `${first}/${second}`
      })
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "r" })).toBe("fast/fast")
      // the second call reads the persisted race exit instead of racing again
      expect(attempts).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  effect("withActivityAttempt scopes the deferred name to the current attempt", () =>
    Effect.gen(function*() {
      const scoped = yield* Gate.withActivityAttempt
      expect(scoped.name).toBe(`${Gate.name}/1`)
      const retryScoped = yield* Gate.withActivityAttempt.pipe(
        Effect.provideService(Activity.CurrentAttempt, 3)
      )
      expect(retryScoped.name).toBe(`${Gate.name}/3`)
    }))

  effect("independent deferreds resume the flow as each one resolves", () => {
    const A = DurableDeferred.make("DurableDeferred/Parallel/A", { success: Schema.String })
    const B = DurableDeferred.make("DurableDeferred/Parallel/B", { success: Schema.String })
    const flow = Flow.make("DurableDeferred/parallel", {
      payload: { id: Schema.String },
      success: Schema.String,
      idempotencyKey: ({ id }) => id
    })
    const layer = flow.toLayer(() =>
      Effect.gen(function*() {
        const a = yield* DurableDeferred.await(A)
        const b = yield* DurableDeferred.await(B)
        return `${a}+${b}`
      })
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "p" }, { discard: true })
      const tokenB = DurableDeferred.tokenFromExecutionId(B, { flow, executionId })
      // resolving the not-yet-awaited deferred first must not complete the flow
      yield* DurableDeferred.succeed(B, { token: tokenB, value: "b" })
      const stillSuspended = yield* flow.poll(executionId)
      expect(Option.isSome(stillSuspended) && stillSuspended.value._tag).toBe("Suspended")

      const tokenA = DurableDeferred.tokenFromExecutionId(A, { flow, executionId })
      yield* DurableDeferred.succeed(A, { token: tokenA, value: "a" })
      const result = yield* flow.poll(executionId)
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toBe("a+b")
      }
    }).pipe(Effect.provide(layer))
  })
})
