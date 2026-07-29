import { Journal, JournalEvent } from "@flows/journal"
import { DurableClock, DurableDeferred, Workflow, WorkflowEngine } from "@flows/workflow-engine"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as DeferredPersistence from "../src/internal/DeferredPersistence.ts"

const TestWorkflow = Workflow.make("DeferredPersistence/Test", {
  payload: {},
  success: Schema.String
})

const makeJournal = (events: Array<string>) =>
  (() => {
    const admissions = new Map<string, {
      readonly seq: JournalEvent.Seq
      readonly sourceSeq: JournalEvent.SourceSeq
    }>()
    return Journal.makeNoop({
      emit: (input) =>
        Effect.sync(() => {
          const sourceSeq = input.sourceSeq ?? 0 as JournalEvent.SourceSeq
          const key = JSON.stringify([input.runId, input.sourceId, sourceSeq])
          const existing = admissions.get(key)
          if (existing !== undefined) {
            return {
              _tag: "Duplicate" as const,
              ...existing,
              status: "committed" as const
            }
          }
          const row = {
            seq: admissions.size as JournalEvent.Seq,
            sourceSeq
          }
          admissions.set(key, row)
          events.push(`emit:${input.eventType}`)
          return {
            _tag: "Accepted" as const,
            ...row
          }
        }),
      flush: Effect.sync(() => {
        events.push("flush")
      })
    })
  })()

const build = (
  state: DurableEngineState.Service,
  journal: Journal.Service,
  resumes: Array<string>,
  onResume?: () => void
) =>
  DeferredPersistence.make({
    journalSource: "deferred-test",
    scheduleResume: (_workflowName, executionId, reason) =>
      Effect.sync(() => {
        onResume?.()
        resumes.push(`${executionId}:${reason}`)
      })
  }).pipe(
    Effect.provideService(DurableEngineState.DurableEngineState, state),
    Effect.provideService(Journal.Journal, journal)
  )

describe("DeferredPersistence", () => {
  it("keeps the first duplicate or divergent completion", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const state = DurableEngineState.makeMemory()
      const events: Array<string> = []
      const resumes: Array<string> = []
      const service = yield* build(state, makeJournal(events), resumes)
      const address = {
        workflowName: TestWorkflow._tag,
        executionId: "duplicate",
        deferredName: "answer"
      }

      yield* service.deferredDone({ ...address, exit: Exit.succeed("first") })
      yield* service.deferredDone({ ...address, exit: Exit.succeed("first") })
      yield* service.deferredDone({ ...address, exit: Exit.succeed("different") })
      return {
        row: Option.getOrThrow(yield* state.deferred(address)),
        events,
        resumes
      }
    })))

    expect(result.row.exit).toEqual(Exit.succeed("first"))
    expect(result.events).toEqual([
      "emit:flows.engine.deferred-completed",
      "flush",
      "flush",
      "flush"
    ])
    expect(result.resumes).toEqual(["duplicate:deferred"])
  })

  it("makes delivery durable before scheduling a resume", async () => {
    const state = DurableEngineState.makeMemory()
    const events: Array<string> = []
    const resumes: Array<string> = []
    let durableAtResume = false
    const address = {
      workflowName: TestWorkflow._tag,
      executionId: "ordered",
      deferredName: "answer"
    }

    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const service = yield* build(state, makeJournal(events), resumes, () => {
        durableAtResume = events.at(-1) === "flush"
      })
      yield* service.deferredDone({
        ...address,
        exit: Exit.succeed("done"),
        metadata: { correlationId: "opaque" }
      })
    })))

    expect(durableAtResume).toBe(true)
    expect(Option.getOrThrow(await Effect.runPromise(state.deferred(address))).metadata).toEqual({
      correlationId: "opaque"
    })
  })

  it("reads a completion from a fresh persistence instance", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const state = DurableEngineState.makeMemory()
      const journal = makeJournal([])
      const first = yield* build(state, journal, [])
      yield* first.deferredDone({
        workflowName: TestWorkflow._tag,
        executionId: "restart",
        deferredName: "answer",
        exit: Exit.succeed("persisted")
      })

      const restarted = yield* build(state, journal, [])
      const instance = WorkflowEngine.WorkflowInstance.initial(
        TestWorkflow,
        "restart"
      )
      return yield* restarted.deferredResult(
        DurableDeferred.make("answer", {
          success: Schema.String
        })
      ).pipe(
        Effect.provideService(WorkflowEngine.WorkflowInstance, instance)
      )
    })))

    expect(Option.getOrThrow(result)).toEqual(Exit.succeed("persisted"))
  })

  it("fires a due clock once and reuses its original deadline on replay", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const state = DurableEngineState.makeMemory()
        const events: Array<string> = []
        const resumes: Array<string> = []
        const journal = makeJournal(events)
        const first = yield* build(state, journal, resumes)
        const clock = DurableClock.make({ name: "wake", duration: "10 seconds" })

        yield* first.scheduleClock(TestWorkflow, {
          executionId: "clock-run",
          clock
        })
        yield* TestClock.adjust("5 seconds")

        const restarted = yield* build(state, journal, resumes)
        yield* restarted.scheduleClock(TestWorkflow, {
          executionId: "clock-run",
          clock
        })
        const before = Option.getOrThrow(
          yield* state.clock({
            workflowName: TestWorkflow._tag,
            executionId: "clock-run",
            clockName: "wake"
          })
        )

        yield* TestClock.adjust("5 seconds")
        yield* Effect.yieldNow
        const after = Option.getOrThrow(yield* state.clock(before))
        return { before, after, events, resumes }
      })).pipe(Effect.provide(TestClock.layer()))
    )

    expect(result.before.dueAtMs).toBe(10_000)
    expect(result.after.completedAtMs).toBe(10_000)
    expect(result.resumes).toEqual(["clock-run:clock"])
    expect(result.events.filter((event) => event === "emit:flows.engine.clock-scheduled")).toHaveLength(1)
    expect(result.events.filter((event) => event === "emit:flows.engine.deferred-completed")).toHaveLength(1)
  })
})
