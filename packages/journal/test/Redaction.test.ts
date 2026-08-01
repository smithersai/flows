import { Database } from "@smithers/database/Database"
import * as TestDatabase from "@smithers/database/test/TestDatabase"
import { Effect, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as AttemptStore from "../src/AttemptStore.ts"
import * as CacheStore from "../src/CacheStore.ts"
import { Journal } from "../src/Journal.ts"
import * as RunStore from "../src/RunStore.ts"
import { Input, type RunId, type SourceId } from "../src/JournalEvent.ts"
import * as Migrations from "../src/Migrations.ts"
import * as Redaction from "../src/Redaction.ts"
import * as SqlJournal from "../src/SqlJournal.ts"

const runId = (value: string): RunId => value as RunId
const sourceId = (value: string): SourceId => value as SourceId

const input = (run: RunId, source: SourceId, eventType: string, payload: unknown, meta?: unknown): Input =>
  new Input({
    runId: run,
    sourceId: source,
    eventType,
    payload,
    ...(meta === undefined ? {} : { meta })
  }, { disableChecks: true })

const journalLayer = (options?: SqlJournal.SqlJournalOptions) =>
  SqlJournal.layer(options ?? { capacity: 8, overflow: "reject", allocation: "sql" }).pipe(
    Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer))
  ) as Layer.Layer<Journal | Database>

const effect = <E>(name: string, body: () => Effect.Effect<void, E>) =>
  it(name, () => Effect.runPromise(body().pipe(Effect.provide(TestClock.layer()))))

describe("Redaction", () => {
  it("redacts credential-named fields wholesale", () => {
    expect(
      Redaction.redact({ apiKey: "sk-ant-api03-abcdefgh", nested: { "x-api-key": "abc", safe: 7 } })
    ).toEqual({
      apiKey: Redaction.placeholder,
      nested: { "x-api-key": Redaction.placeholder, safe: 7 }
    })
  })

  it("redacts credential-shaped strings anywhere in the payload", () => {
    expect(
      Redaction.redact({
        headers: ["Authorization: Bearer abcdefghijkl"],
        note: "use sk-proj-abcdefghij when calling",
        env: "ANTHROPIC_API_KEY=shhh"
      })
    ).toEqual({
      headers: ["Authorization: Bearer [REDACTED_TOKEN]"],
      note: "use [REDACTED_API_KEY] when calling",
      env: `ANTHROPIC_API_KEY=${Redaction.placeholder}`
    })
  })

  it("leaves non-credential data untouched and survives cycles", () => {
    const cyclic: Record<string, unknown> = { count: 3, flag: false, text: "plain" }
    cyclic["self"] = cyclic
    expect(Redaction.redact(cyclic)).toEqual({
      count: 3,
      flag: false,
      text: "plain",
      self: "[Circular]"
    })
  })

  it("makeNoop persists the value verbatim", () => {
    expect(Redaction.makeNoop()({ token: "raw" })).toEqual({ token: "raw" })
    expect(Redaction.make()({ token: "raw" })).toEqual({ token: Redaction.placeholder })
  })

  effect("never persists a secret through the durable channel", () =>
    Effect.gen(function*() {
      const journal = yield* Journal
      const run = runId("redaction-durable")
      yield* journal.emitDurable(
        input(run, sourceId("activity"), "activity.completed", {
          apiKey: "sk-ant-api03-abcdefgh",
          prompt: "call with Bearer abcdefghijkl"
        }, { authorization: "Bearer abcdefghijkl" })
      )
      const page = yield* journal.entries({ runId: run, limit: 10 })
      const entry = page.entries[0]!
      expect(entry.payload).toEqual({
        apiKey: Redaction.placeholder,
        prompt: "call with Bearer [REDACTED_TOKEN]"
      })
      expect(entry.meta).toEqual({ authorization: Redaction.placeholder })
    }).pipe(Effect.provide(journalLayer()), Effect.scoped))

  effect("never persists a secret through the lossy queue either", () =>
    Effect.gen(function*() {
      const journal = yield* Journal
      const run = runId("redaction-lossy")
      yield* journal.emitLossy(input(run, sourceId("telemetry"), "tool.call", { secret: "hunter2" }))
      yield* journal.flush
      const page = yield* journal.entries({ runId: run, limit: 10 })
      expect(page.entries[0]!.payload).toEqual({ secret: Redaction.placeholder })
    }).pipe(
      Effect.provide(journalLayer({ capacity: 8, overflow: "reject" })),
      Effect.scoped
    ))

  it("redactJsonString returns the input when it cannot re-encode it", () => {
    expect(Redaction.redactJsonString("{ not json", Redaction.make())).toBe("{ not json")
    // A redactor that drops the value entirely has nothing to encode; the
    // caller's already-validated JSON is kept rather than corrupted.
    expect(Redaction.redactJsonString(`{"a":1}`, () => undefined)).toBe(`{"a":1}`)
    expect(Redaction.redactJsonString(`{"token":"raw"}`, Redaction.make())).toBe(
      `{"token":"${Redaction.placeholder}"}`
    )
  })

  const secret = { apiKey: "sk-ant-api03-abcdefgh", note: "call with Bearer abcdefghijkl" }
  const scrubbed = { apiKey: Redaction.placeholder, note: "call with Bearer [REDACTED_TOKEN]" }

  const storeLayers = Layer.mergeAll(
    RunStore.layer,
    AttemptStore.layer,
    CacheStore.layer
  ).pipe(Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer)))

  const withStores = <A, E>(
    body: Effect.Effect<A, E, RunStore.RunStore | AttemptStore.AttemptStore | CacheStore.CacheStore | Database>
  ) => Effect.runPromise(body.pipe(Effect.provide(storeLayers), Effect.provide(TestClock.layer())))

  it("never persists a secret in a run's durable state", async () => {
    const stateJson = await withStores(Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create("run-redaction", JSON.stringify({ payload: secret }))
      return (yield* store.get("run-redaction")).stateJson
    }))

    expect(JSON.parse(stateJson)).toEqual({ payload: scrubbed })
  })

  it("never persists a secret in an attempt checkpoint, error, or outcome", async () => {
    const attempt = await withStores(Effect.gen(function*() {
      const database = yield* Database
      yield* database.sql`
        INSERT INTO flows_runs (
          run_id, status, created_at_ms, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms, state_json
        ) VALUES ('run-attempt', 'running', 1, 'host-a', 42, 'nonce-a', 1, '{}')
      `
      const store = yield* AttemptStore.AttemptStore
      const owner = { hostId: "host-a", pid: 42, nonce: "nonce-a" }
      yield* store.put({
        runId: "run-attempt",
        stepKeyDigest: "digest-1",
        attempt: 0,
        state: "running",
        startedAtMs: 10,
        checkpoint: secret,
        meta: secret
      }, owner)
      yield* store.finish({
        runId: "run-attempt",
        stepKeyDigest: "digest-1",
        attempt: 0,
        state: "failed",
        finishedAtMs: 20,
        error: secret,
        outcome: secret
      }, owner)
      return yield* store.get({ runId: "run-attempt", stepKeyDigest: "digest-1", attempt: 0 })
    }))

    expect(Option.getOrThrow(attempt)).toMatchObject({
      checkpoint: scrubbed,
      error: scrubbed,
      outcome: scrubbed,
      meta: scrubbed
    })
  })

  it("never persists a secret in a cached step result", async () => {
    const entry = await withStores(Effect.gen(function*() {
      const store = yield* CacheStore.CacheStore
      yield* store.put({
        keyDigest: "digest-cache",
        result: secret,
        meta: secret,
        createdAtMs: 1,
        recordedRunId: "run-cache",
        recordedEventSeq: 0
      })
      return yield* store.get("digest-cache")
    }))

    expect(Option.getOrThrow(entry)).toMatchObject({ result: scrubbed, meta: scrubbed })
  })

  it("keeps store payloads verbatim when redaction is disabled", async () => {
    const noop = Layer.mergeAll(
      RunStore.layerWith({ redact: Redaction.makeNoop() }),
      CacheStore.layerWith({ redact: Redaction.makeNoop() })
    ).pipe(Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer)))

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const runStore = yield* RunStore.RunStore
        const cacheStore = yield* CacheStore.CacheStore
        yield* runStore.create("run-raw", JSON.stringify(secret))
        yield* cacheStore.put({
          keyDigest: "digest-raw",
          result: secret,
          meta: null,
          createdAtMs: 1,
          recordedRunId: "run-raw",
          recordedEventSeq: 0
        })
        return {
          stateJson: (yield* runStore.get("run-raw")).stateJson,
          cached: Option.getOrThrow(yield* cacheStore.get("digest-raw")).result
        }
      }).pipe(Effect.provide(noop), Effect.provide(TestClock.layer()))
    )

    expect(JSON.parse(result.stateJson)).toEqual(secret)
    expect(result.cached).toEqual(secret)
  })

  effect("keeps payloads verbatim when redaction is disabled", () =>
    Effect.gen(function*() {
      const journal = yield* Journal
      const run = runId("redaction-off")
      yield* journal.emitDurable(input(run, sourceId("activity"), "raw", { token: "hunter2" }))
      const page = yield* journal.entries({ runId: run, limit: 10 })
      expect(page.entries[0]!.payload).toEqual({ token: "hunter2" })
    }).pipe(
      Effect.provide(
        journalLayer({ capacity: 8, overflow: "reject", allocation: "sql", redact: Redaction.makeNoop() })
      ),
      Effect.scoped
    ))
})
