import * as TestDatabase from "@smthrs/database-next/test/TestDatabase"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { createHash, webcrypto } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  Action,
  EngineStore as EngineStorePackage,
  Flow,
  FlowRuntime,
  Interpreter,
  Journal as JournalPackage,
  Kernel,
  Plan as PlanPackage,
  RunStore as RunStorePackage,
  StepCache
} from "../src/index.ts"

const { DurableEngineState, EngineStore, Migrations, OwnerIdentity, StepBoundary } = EngineStorePackage
const { SqlJournal } = JournalPackage
const { Jj } = Kernel
const { Node, PlanStore } = PlanPackage
const { AttemptStore, RunStore } = RunStorePackage
const { CacheStore } = StepCache

const hostCrypto: Layer.Layer<Crypto.Crypto> = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => webcrypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.succeed(
        new Uint8Array(createHash(algorithm.replace("-", "").toLowerCase()).update(data).digest())
      )
  })
)

const jj = Jj.make({
  snapshot: () => Effect.succeed({ changeId: "authoring-errors" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

const services = Layer.mergeAll(
  SqlJournal.layer({ capacity: 128, overflow: "reject" }),
  RunStore.layer,
  AttemptStore.layer,
  CacheStore.layer,
  PlanStore.layer,
  DurableEngineState.layer
).pipe(
  Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer)),
  Layer.merge(OwnerIdentity.layer),
  Layer.merge(StepBoundary.layerTest()),
  Layer.merge(Layer.succeed(Jj.Jj, jj))
)

const durable = <A, E, R>(body: Effect.Effect<A, E, R>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(body.pipe(Effect.provide(services), Effect.provide(hostCrypto))) as Effect.Effect<A>
  )

type Implementation = Layer.Layer<never, never, Action.Implementations | FlowRuntime.FlowRuntime>

const incarnation = (options: {
  readonly flows: ReadonlyArray<Flow.Any>
  readonly implementations?: ReadonlyArray<Implementation> | undefined
}) =>
  Effect.gen(function*() {
    const engine = yield* EngineStore.make({
      owner: { hostId: "authoring-errors" },
      journalSource: "authoring-errors",
      isAlive: () => Effect.succeed(false)
    })
    const wiring = [
      ...options.implementations ?? [],
      ...options.flows.map((flow) => Interpreter.layer(flow as never) as Implementation)
    ].reduce<Implementation>((left, right) => Layer.merge(left, right), Layer.empty).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
    )
    return { engine, wiring }
  })

describe("authoring input errors", () => {
  it("surfaces a typed InterpreterError naming an action whose implementation layer is missing", async () => {
    const MissingAction = Action.make("authoring/missing-action", {
      payload: { value: Schema.Number },
      success: Schema.Number
    })
    const MissingFlow = Flow.make("authoring/missing-flow", {
      payload: { value: Schema.Number },
      success: Schema.Number,
      error: Interpreter.InterpreterError,
      body: ({ value }) => MissingAction.call({ value })
    })

    const observed = await durable(Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const { wiring } = yield* incarnation({ flows: [MissingFlow] })
      const error = yield* MissingFlow.execute(
        { value: 1 },
        { executionId: "missing-action-run" }
      ).pipe(
        Effect.provideService(MissingAction.requirement, {
          name: MissingAction.name,
          action: () => Effect.die("compile-time requirement only")
        }),
        Effect.provide(wiring),
        Effect.flip
      )
      return { error, row: yield* store.get("missing-action-run") }
    }))

    expect(observed.error._tag).toBe("@smthrs/flow-next/InterpreterError")
    expect(observed.error.code).toBe("unresolved_action")
    expect(observed.error.flow).toBe("authoring/missing-flow")
    expect(observed.error.node).toContain("root.flow")
    expect(observed.error.message).toContain('Action "authoring/missing-action" has no implementation')
    expect(observed.error.message).toContain("Action.layerImplementations")
    expect(observed.row.status).toBe("failed")
  })

  // BUG: Flow.execute uses Schema.make, so invalid caller input dies with a
  // plain Error instead of failing with the schema's typed SchemaError.
  it.fails("fails an invalid execute payload with a typed SchemaError and field path", async () => {
    const Checked = Flow.make("authoring/schema-checked", {
      payload: { count: Schema.Number },
      success: Schema.Number,
      body: ({ count }) => Node.succeed(count)
    })

    const exit = await durable(Effect.gen(function*() {
      const { wiring } = yield* incarnation({ flows: [Checked] })
      return yield* Checked.execute(
        { count: "not-a-number" } as unknown as { readonly count: number },
        { executionId: "invalid-payload-run" }
      ).pipe(Effect.provide(wiring), Effect.exit)
    }))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const reason = exit.cause.reasons[0]
      expect(reason?._tag).toBe("Fail")
      const error = reason?._tag === "Fail" ? reason.error : undefined
      expect(error).toMatchObject({ _tag: "SchemaError" })
      expect(String(error)).toContain("count")
    }
  })

  it.each([0, -1])("rejects maxRounds: %i as a synchronous authoring RangeError", (maxRounds) => {
    expect(() =>
      Flow.make(`authoring/max-rounds-${maxRounds}`, {
        payload: {},
        maxRounds,
        body: () => Node.succeed(undefined)
      })
    ).toThrowError(
      new RangeError(`Flow "authoring/max-rounds-${maxRounds}" maxRounds must be a positive safe integer`)
    )
  })

  it("lets a later registration for the same flow tag replace the prior handler", async () => {
    const First = Flow.make("authoring/duplicate-tag", {
      payload: {},
      success: Schema.String,
      body: () => Node.succeed("first-body")
    })
    const Second = Flow.make("authoring/duplicate-tag", {
      payload: {},
      success: Schema.String,
      body: () => Node.succeed("second-body")
    })

    const observed = await durable(Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const { engine } = yield* incarnation({ flows: [] })
      yield* engine.register(First, () => Effect.succeed("first-handler"))
      yield* engine.register(Second, () => Effect.succeed("second-handler"))
      const value = yield* engine.execute(First, {
        executionId: "duplicate-tag-run",
        payload: {}
      })
      return { row: yield* store.get("duplicate-tag-run"), value }
    }))

    expect(observed.value).toBe("second-handler")
    expect(observed.row.status).toBe("completed")
  })

  // BUG: the durable runtime returns Option.none for an unknown execution,
  // so callers cannot distinguish "not found" from a known, unsettled run.
  it.fails("fails poll on an unknown execution id with typed not-found", async () => {
    const Pollable = Flow.make("authoring/pollable", {
      payload: {},
      success: Schema.String,
      body: () => Node.succeed("done")
    })

    const exit = await durable(Effect.gen(function*() {
      const { wiring } = yield* incarnation({ flows: [Pollable] })
      return yield* Pollable.poll("unknown-execution").pipe(
        Effect.provide(wiring),
        Effect.exit
      )
    }))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const reason = exit.cause.reasons[0]
      expect(reason?._tag).toBe("Fail")
      const error = reason?._tag === "Fail" ? reason.error : undefined
      expect(error).toMatchObject({
        _tag: "@smthrs/flow-next/FlowExecutionNotFound",
        executionId: "unknown-execution"
      })
      expect(String(error)).toContain("unknown-execution")
    }
  })
})
