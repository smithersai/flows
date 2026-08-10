import * as Jj from "@smthrs/jj"
import * as RunStore from "@smthrs/journal/RunStore"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as Fork from "../src/Fork.ts"
import * as Frame from "../src/Frame.ts"
import * as TimeTravel from "../src/index.ts"
import * as MemoryTimeTravelStore from "../src/MemoryTimeTravelStore.ts"
import { error, TimeTravelError, TimeTravelErrorCode } from "../src/TimeTravelError.ts"
import { TimeTravelStore } from "../src/TimeTravelStore.ts"

const frame = { lineageId: "parent/root", seq: 0 } as const
const owner = { hostId: "host", pid: 1, nonce: "owner" } as const

const row = (overrides: Partial<RunStore.RunRow> = {}): RunStore.RunRow => ({
  runId: "parent",
  status: "suspended",
  createdAtMs: 0,
  startedAtMs: 0,
  finishedAtMs: null,
  owner: null,
  heartbeatAtMs: null,
  claim: null,
  claimedAtMs: null,
  parentRunId: null,
  cancelRequestedAtMs: null,
  stateJson: "{}",
  ...overrides
})

const runFork = (
  runs: RunStore.Service,
  store: TimeTravelStore["Service"],
  jj: Jj.Jj
) =>
  Effect.runPromise(
    Effect.scoped(
      Fork.fork({
        parentRunId: "parent",
        frame,
        workspaceName: "fork-workspace",
        workspacePath: "/tmp/fork-workspace"
      }).pipe(
        Effect.provide(Layer.succeed(RunStore.RunStore, runs)),
        Effect.provide(Layer.succeed(TimeTravelStore, store)),
        Effect.provide(Layer.succeed(Jj.Jj, jj))
      )
    )
  )

describe("public time-travel modules", () => {
  it("exports every production namespace from the package barrel", () => {
    expect(Object.keys(TimeTravel).sort()).toEqual([
      "Compensation",
      "EffectBoundary",
      "EffectHandlerRegistry",
      "Fork",
      "Frame",
      "MemoryTimeTravelStore",
      "Recovery",
      "Replay",
      "Retry",
      "Rewind",
      "SqlTimeTravelStore",
      "TimeTravelError",
      "TimeTravelStore"
    ])
  })

  it("accepts the exact frame boundary and every lineage edge kind", () => {
    expect(Schema.decodeUnknownSync(Frame.Frame)({ lineageId: "root", seq: 0 })).toEqual({
      lineageId: "root",
      seq: 0
    })
    for (const kind of ["child", "fork", "continuation"] as const) {
      expect(Schema.decodeUnknownSync(Frame.LineageEdgeKind)(kind)).toBe(kind)
    }
  })

  it("rejects malformed frames and lineage edge kinds", () => {
    for (
      const malformed of [
        { lineageId: "", seq: 0 },
        { lineageId: "root", seq: -1 },
        { lineageId: "root", seq: 0.5 },
        { lineageId: "root", seq: "0" }
      ]
    ) {
      expect(() => Schema.decodeUnknownSync(Frame.Frame)(malformed)).toThrow()
    }
    expect(() => Schema.decodeUnknownSync(Frame.LineageEdgeKind)("reset")).toThrow()
  })

  it("constructs every stable error variant with optional cause semantics", () => {
    const codes = Schema.decodeUnknownSync(Schema.Array(TimeTravelErrorCode))([
      "busy",
      "live_parent",
      "live_child",
      "not_found",
      "rate_limited",
      "compensation_failed",
      "irreversible",
      "unknown"
    ])
    const failures = codes.map((code) => error(code, code))
    const caused = error("unknown", "caused", "root-cause")

    expect(failures.every((failure) => failure instanceof TimeTravelError)).toBe(true)
    expect(failures.map((failure) => failure.code)).toEqual(codes)
    expect(failures.every((failure) => failure.cause === undefined)).toBe(true)
    expect(caused.cause).toBe("root-cause")
  })
})

describe("Fork.fork", () => {
  it("creates the fork workspace and always forgets it when the scope closes", async () => {
    const calls: Array<string> = []
    const store = MemoryTimeTravelStore.make({
      records: [{ runId: "parent", seq: 0, eventId: "e0", lineageId: "parent/root", payload: {} }]
    })
    const result = await runFork(
      RunStore.makeNoop({ get: () => Effect.succeed(row()) }),
      store,
      Jj.makeNoop({
        workspaceAdd: (name, path) => Effect.sync(() => calls.push(`add:${name}:${path}`)),
        workspaceForget: (name) => Effect.sync(() => calls.push(`forget:${name}`))
      })
    )

    expect(result).toMatchObject({ edge: { parentRunId: "parent", parentSeq: 0, kind: "fork" } })
    expect(calls).toEqual([
      "add:fork-workspace:/tmp/fork-workspace",
      "forget:fork-workspace"
    ])
  })

  it("maps parent-read and workspace-add failures without leaking a workspace", async () => {
    const addFailure = await Effect.runPromise(
      Effect.flip(
        Effect.scoped(
          Fork.fork({
            parentRunId: "parent",
            frame,
            workspaceName: "fork-workspace",
            workspacePath: "/tmp/fork-workspace"
          }).pipe(
            Effect.provide(Layer.succeed(RunStore.RunStore, RunStore.makeNoop({ get: () => Effect.succeed(row()) }))),
            Effect.provide(Layer.succeed(TimeTravelStore, MemoryTimeTravelStore.make())),
            Effect.provide(Layer.succeed(Jj.Jj, Jj.makeNoop({})))
          )
        )
      )
    )
    const readFailure = await Effect.runPromise(
      Effect.flip(
        Effect.scoped(
          Fork.fork({
            parentRunId: "parent",
            frame,
            workspaceName: "fork-workspace",
            workspacePath: "/tmp/fork-workspace"
          }).pipe(
            Effect.provide(Layer.succeed(RunStore.RunStore, RunStore.makeNoop())),
            Effect.provide(Layer.succeed(TimeTravelStore, MemoryTimeTravelStore.make())),
            Effect.provide(Layer.succeed(Jj.Jj, Jj.makeNoop({})))
          )
        )
      )
    )

    expect(addFailure).toMatchObject({ code: "unknown", message: "could not add fork workspace" })
    expect(readFailure).toMatchObject({ code: "unknown", message: "could not read parent" })
  })

  it("rejects every live-parent signal before copying history or adding a workspace", async () => {
    const liveRows = [
      row({ status: "running", owner }),
      row({ claim: owner, claimedAtMs: 1 }),
      row({ owner, heartbeatAtMs: 1 })
    ]
    for (const liveRow of liveRows) {
      let added = false
      const store = MemoryTimeTravelStore.make()
      const failure = await Effect.runPromise(
        Effect.flip(
          Effect.scoped(
            Fork.fork({
              parentRunId: "parent",
              frame,
              workspaceName: "fork-workspace",
              workspacePath: "/tmp/fork-workspace"
            }).pipe(
              Effect.provide(
                Layer.succeed(RunStore.RunStore, RunStore.makeNoop({ get: () => Effect.succeed(liveRow) }))
              ),
              Effect.provide(Layer.succeed(TimeTravelStore, store)),
              Effect.provide(
                Layer.succeed(
                  Jj.Jj,
                  Jj.makeNoop({ workspaceAdd: () => Effect.sync(() => void (added = true)) })
                )
              )
            )
          )
        )
      )

      expect(failure).toMatchObject({ code: "live_parent", message: "parent run parent is live" })
      expect(store.state().records).toEqual([])
      expect(added).toBe(false)
    }
  })
})
