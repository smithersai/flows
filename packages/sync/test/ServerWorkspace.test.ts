/**
 * Workspace-scope paging, catalog fan-out, and journal failure mapping.
 *
 * @since 0.1.0
 */
import { Journal, JournalEvent } from "@smithers/journal"
import { Effect, Exit, Fiber, Layer, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as RunCatalog from "../src/RunCatalog.ts"
import { SyncError } from "../src/SyncError.ts"
import * as SyncServer from "../src/SyncServer.ts"

const runId = (value: string) => value as JournalEvent.RunId
const sourceId = (value: string) => value as JournalEvent.SourceId
const seq = (value: number) => value as JournalEvent.Seq
const sourceSeq = (value: number) => value as JournalEvent.SourceSeq

const entry = (id: string, sequence: number) =>
  new JournalEvent.Entry({
    runId: runId(id),
    seq: seq(sequence),
    eventId: `${id}-${sequence}`,
    sourceId: sourceId("source"),
    sourceSeq: sourceSeq(sequence),
    emittedAtMs: sequence,
    eventType: "event",
    payload: sequence,
    meta: null
  })

const journalOf = (byRun: Record<string, ReadonlyArray<JournalEvent.Entry>>) =>
  Journal.layerNoop({
    entries: ({ after, limit, runId: id }: any) => {
      const all = (byRun[id] ?? []).filter((value) => after === undefined || value.seq > after)
      const page = all.slice(0, limit)
      return Effect.succeed({ entries: page, hasMore: page.length < all.length })
    },
    stream: ({ afterSequence, runId: id }: any) =>
      Stream.fromIterable(
        (byRun[id] ?? []).filter((value) => afterSequence === undefined || value.seq > afterSequence)
      )
  } as any)

describe("SyncServer workspace scope", () => {
  it("pages runs in a stable order and reports the durable tail", async () => {
    const response = await Effect.runPromise(
      Effect.gen(function*() {
        const server = yield* SyncServer.makeLive
        return yield* server.read({
          scope: { _tag: "Workspace" },
          cursors: [],
          limit: 10
        })
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            journalOf({ b: [entry("b", 0)], a: [entry("a", 0), entry("a", 1)] }),
            RunCatalog.layerStatic([runId("b"), runId("a")])
          )
        )
      )
    )

    expect(response.entries.map((value) => `${value.runId}:${value.seq}`)).toEqual(["a:0", "a:1", "b:0"])
    expect(response.cursors).toEqual([
      { runId: "a", afterSeq: 1 },
      { runId: "b", afterSeq: 0 }
    ])
    expect(response.done).toBe(true)
  })

  it("stops at the limit and reports that the page is not done", async () => {
    const response = await Effect.runPromise(
      Effect.gen(function*() {
        const server = yield* SyncServer.makeLive
        return yield* server.read({
          scope: { _tag: "Workspace" },
          cursors: [],
          limit: 2
        })
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            journalOf({ a: [entry("a", 0), entry("a", 1), entry("a", 2)], b: [entry("b", 0)] }),
            RunCatalog.layerStatic([runId("a"), runId("b")])
          )
        )
      )
    )

    expect(response.entries.map((value) => value.seq)).toEqual([0, 1])
    expect(response.done).toBe(false)
  })

  it("resumes each run from its supplied cursor and preserves untouched cursors", async () => {
    const response = await Effect.runPromise(
      Effect.gen(function*() {
        const server = yield* SyncServer.makeLive
        return yield* server.read({
          scope: { _tag: "Workspace" },
          cursors: [
            { runId: runId("a"), afterSeq: seq(0) },
            { runId: runId("ghost"), afterSeq: seq(4) }
          ],
          limit: 10
        })
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            journalOf({ a: [entry("a", 0), entry("a", 1)] }),
            RunCatalog.layerStatic([runId("a")])
          )
        )
      )
    )

    expect(response.entries.map((value) => value.seq)).toEqual([1])
    expect(response.cursors).toEqual([
      { runId: "a", afterSeq: 1 },
      { runId: "ghost", afterSeq: 4 }
    ])
  })

  it("maps a journal read failure to a sync error", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function*() {
        const server = yield* SyncServer.makeLive
        return yield* server.read({
          scope: { _tag: "Run", runId: runId("a") },
          cursors: [],
          limit: 10
        })
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Journal.layerNoop({
              entries: (() => Effect.fail(new Error("disk gone"))) as any
            }),
            RunCatalog.layerNoop
          )
        )
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
      expect(failure).toBeInstanceOf(SyncError)
      expect(failure).toMatchObject({ code: "unknown", message: "disk gone" })
    }
  })

  it("subscribes across every catalog run and honours the credit limit", async () => {
    const frames = await Effect.runPromise(
      Effect.gen(function*() {
        const server = yield* SyncServer.makeLive
        return yield* Stream.runCollect(
          server.subscribe({ scope: { _tag: "Workspace" }, cursors: [], credit: 3 })
        )
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            journalOf({ a: [entry("a", 0), entry("a", 1)], b: [entry("b", 0)] }),
            RunCatalog.layerStatic([runId("a"), runId("b")])
          )
        )
      )
    )

    const collected = Array.from(frames)
    expect(collected).toHaveLength(3)
    expect(
      collected.map((frame) => frame._tag === "Entries" ? `${frame.runId}:${frame.toSeq}` : frame._tag).sort()
    ).toEqual(["a:0", "a:1", "b:0"])
  })

  it("picks up runs registered after the subscription started", async () => {
    const frames = await Effect.runPromise(
      Effect.gen(function*() {
        const memory = yield* RunCatalog.makeMemory()
        const server = yield* SyncServer.makeLive.pipe(
          Effect.provideService(RunCatalog.RunCatalog, memory.catalog)
        )
        const fiber = yield* Effect.forkChild(
          Stream.runCollect(
            server.subscribe({ scope: { _tag: "Workspace" }, cursors: [], credit: 1 })
          ),
          { startImmediately: true }
        )
        // let the subscription attach to the catalog change feed first
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        yield* memory.register(runId("late"))
        return yield* Effect.exit(Fiber.join(fiber))
      }).pipe(
        Effect.provide(journalOf({ late: [entry("late", 0)] })),
        Effect.scoped
      )
    )

    expect(Exit.isSuccess(frames)).toBe(true)
    if (Exit.isSuccess(frames)) {
      expect(Array.from(frames.value)).toMatchObject([{ _tag: "Entries", runId: "late", toSeq: 0 }])
    }
  })

  it("makeNoop reports an empty read and a closed subscription", async () => {
    const noop = SyncServer.makeNoop()
    expect(await Effect.runPromise(noop.read({ scope: { _tag: "Workspace" }, cursors: [], limit: 1 })))
      .toEqual({ entries: [], cursors: [], done: true })
    const frames = await Effect.runPromise(
      Stream.runCollect(noop.subscribe({ scope: { _tag: "Workspace" }, cursors: [], credit: 1 }))
    )
    expect(Array.from(frames)).toMatchObject([{ _tag: "Closed" }])
  })
})

describe("RunCatalog", () => {
  it("layerStatic deduplicates ids and never emits changes", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const catalog = yield* RunCatalog.RunCatalog
        const ids = yield* catalog.list
        const changes = yield* Stream.runCollect(catalog.changes)
        return { ids, changes: Array.from(changes) }
      }).pipe(Effect.provide(RunCatalog.layerStatic([runId("a"), runId("a"), runId("b")])))
    )

    expect(result.ids).toEqual(["a", "b"])
    expect(result.changes).toEqual([])
  })

  it("makeMemory publishes each run exactly once", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const memory = yield* RunCatalog.makeMemory()
        const fiber = yield* Effect.forkChild(
          Stream.runCollect(Stream.take(memory.catalog.changes, 2)),
          { startImmediately: true }
        )
        yield* memory.register(runId("one"))
        // a repeated registration must not publish a second change
        yield* memory.register(runId("one"))
        yield* memory.register(runId("two"))
        const changes = yield* Effect.exit(Fiber.join(fiber))
        return { changes, ids: yield* memory.catalog.list }
      }).pipe(Effect.scoped)
    )

    expect(result.ids).toEqual(["one", "two"])
    expect(Exit.isSuccess(result.changes)).toBe(true)
    if (Exit.isSuccess(result.changes)) {
      expect(Array.from(result.changes.value)).toEqual(["one", "two"])
    }
  })

  it("layerNoop lists no runs", async () => {
    const ids = await Effect.runPromise(
      Effect.flatMap(RunCatalog.RunCatalog, (catalog) => catalog.list).pipe(
        Effect.provide(RunCatalog.layerNoop)
      )
    )
    expect(ids).toEqual([])
  })
})
