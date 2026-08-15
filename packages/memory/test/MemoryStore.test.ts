import { Effect } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as MemoryStore from "../src/MemoryStore.ts"
import { literalFtsQuery } from "../src/RecallFts.ts"
import * as TestMemory from "../src/test/TestMemory.ts"

const namespace = { kind: "flow", id: "project-1" } as const

const run = <A, E>(effect: Effect.Effect<A, E, MemoryStore.MemoryStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestMemory.layer), Effect.provide(TestClock.layer())))

describe("MemoryStore", () => {
  it("applies the authoritative and projection schemas idempotently", async () => {
    const tables = await Effect.runPromise(
      Effect.gen(function*() {
        yield* MemoryStore.MemoryStore
        yield* MemoryStore.make
        yield* MemoryStore.make
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const rows = yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name LIKE 'memory_%'
          ORDER BY name
        `
        return rows.map((row) => row.name)
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(tables).toEqual([
      "memory_facts",
      "memory_fts_kinds",
      "memory_messages",
      "memory_note_supersedes",
      "memory_notes",
      "memory_threads",
      "memory_vectors"
    ])
  })

  it("upserts facts last-write-wins and restarts TTL from the last update", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putFact({
        namespace,
        key: "session:state",
        value: { version: 1 },
        ttlMs: 10,
        provenance: { runId: "run-1" }
      })
      yield* TestClock.adjust("6 millis")
      yield* store.putFact({
        namespace,
        key: "session:state",
        value: { version: 2 },
        ttlMs: 10,
        provenance: { runId: "run-2" }
      })
      yield* store.putFact({
        namespace,
        key: "other",
        value: "ignored by prefix",
        provenance: {}
      })
      yield* TestClock.adjust("5 millis")
      const current = yield* store.getFact({ namespace, key: "session:state" })
      const listed = yield* store.listFacts({ namespace, prefix: "session:" })
      yield* TestClock.adjust("5 millis")
      const expired = yield* store.getFact({ namespace, key: "session:state" })
      const afterExpiry = yield* store.listFacts({ namespace, prefix: "session:" })
      return { current, listed, expired, afterExpiry }
    }))

    expect(result.current).toMatchObject({ value: { version: 2 }, provenance: { runId: "run-2" } })
    expect(result.listed.map((fact) => fact.key)).toEqual(["session:state"])
    expect(result.expired).toBeUndefined()
    expect(result.afterExpiry).toEqual([])
  })

  it("appends ordered history idempotently on message id", async () => {
    const messages = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.appendMessage({ threadId: "thread-1", id: "b", role: "assistant", text: "second", at: 2 })
      yield* store.appendMessage({ threadId: "thread-1", id: "a", role: "user", text: "first", at: 1 })
      yield* store.appendMessage({
        threadId: "thread-1",
        id: "a",
        role: "user",
        text: "must not replace",
        at: 9
      })
      return yield* store.listMessages({ threadId: "thread-1" })
    }))

    expect(messages).toEqual([
      { threadId: "thread-1", id: "a", role: "user", text: "first", at: 1 },
      { threadId: "thread-1", id: "b", role: "assistant", text: "second", at: 2 }
    ])
  })

  it("supports the complete fact, thread, note, and message contract", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putFact({ namespace, key: "delete-me", value: "value", provenance: {} })
      const allFacts = yield* store.listAllFacts()
      const deletedFact = yield* store.deleteFact({ namespace, key: "delete-me" })
      const thread = yield* store.createThread({
        id: "thread-crud",
        namespace,
        title: "Review",
        metadata: { branch: "main" }
      })
      yield* store.appendMessage({
        threadId: thread.id,
        id: "message-1",
        role: "user",
        text: "hello",
        at: 1
      })
      const count = yield* store.countMessages({ threadId: thread.id })
      const fetched = yield* store.getThread(thread.id)
      const threads = yield* store.listThreads({ namespace })
      yield* store.putNote({
        namespace,
        id: "get-note",
        text: "note",
        tags: [],
        provenance: {}
      })
      const note = yield* store.getNote({ id: "get-note" })
      const deletedThread = yield* store.deleteThread(thread.id)
      const missing = yield* store.getThread(thread.id)
      return {
        allFacts,
        deletedFact,
        count,
        fetched,
        threads,
        note,
        deletedThread,
        missing
      }
    }))

    expect(result.allFacts.map((fact) => fact.key)).toEqual(["delete-me"])
    expect(result.deletedFact).toBe(true)
    expect(result.count).toBe(1)
    expect(result.fetched).toMatchObject({ title: "Review", metadata: { branch: "main" } })
    expect(result.threads.map((thread) => thread.id)).toEqual(["thread-crud"])
    expect(result.note).toMatchObject({ id: "get-note", text: "note" })
    expect(result.deletedThread).toBe(true)
    expect(result.missing).toBeUndefined()
  })

  it("projects equal record ids independently in different namespaces", async () => {
    const rows = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* store.putFact({
          namespace: { kind: "flow", id: "one" },
          key: "shared",
          value: "first",
          provenance: {}
        })
        yield* store.putFact({
          namespace: { kind: "flow", id: "two" },
          key: "shared",
          value: "second",
          provenance: {}
        })
        return yield* sql<{ readonly namespace_id: string }>`
          SELECT namespace_id FROM memory_vectors
          WHERE record_kind = 'fact' AND record_id = 'shared'
          ORDER BY namespace_id
        `
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(rows.map((row) => row.namespace_id)).toEqual(["one", "two"])
  })

  it("keeps notes immutable and hides targets only for accepted superseders", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putNote({
        namespace,
        id: "old",
        text: "old guidance",
        tags: ["scope:project"],
        provenance: { runId: "run-1" }
      })
      const duplicate = yield* store.putNote({
        namespace,
        id: "old",
        text: "attempted mutation",
        tags: ["scope:secret"],
        provenance: { runId: "run-2" }
      })
      yield* store.putNote({
        namespace,
        id: "replacement",
        text: "new guidance",
        tags: ["scope:project"],
        provenance: { runId: "run-3" },
        status: "pending",
        supersedes: ["old"]
      })
      const pending = yield* store.listNotes({ namespace })
      yield* store.setNoteStatus({ id: "replacement", status: "accepted" })
      const accepted = yield* store.listNotes({ namespace })
      yield* store.setNoteStatus({ id: "replacement", status: "rejected" })
      const rejected = yield* store.listNotes({ namespace })
      const audit = yield* store.listNotes({ namespace, status: "any", includeSuperseded: true })
      return { duplicate, pending, accepted, rejected, audit }
    }))

    expect(result.duplicate).toMatchObject({
      text: "old guidance",
      tags: ["scope:project"],
      provenance: { runId: "run-1" }
    })
    expect(result.pending.map((note) => note.id)).toEqual(["old"])
    expect(result.accepted.map((note) => note.id)).toEqual(["replacement"])
    expect(result.rejected.map((note) => note.id)).toEqual(["old"])
    expect(result.audit.map((note) => [note.id, note.text])).toEqual([
      ["old", "old guidance"],
      ["replacement", "new guidance"]
    ])
  })

  it("writes standalone supersession edges idempotently and rejects invalid edges", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putNote({
        namespace,
        id: "target",
        text: "target",
        tags: [],
        provenance: {}
      })
      yield* store.putNote({
        namespace,
        id: "superseder",
        text: "superseder",
        tags: [],
        provenance: {}
      })
      yield* store.supersede({ supersederId: "superseder", targetId: "target" })
      yield* store.supersede({ supersederId: "superseder", targetId: "target" })
      const visible = yield* store.listNotes({ namespace })
      const invalid = yield* Effect.flip(store.supersede({ supersederId: "missing", targetId: "target" }))
      return { visible, invalid }
    }))

    expect(result.visible.map((note) => note.id)).toEqual(["superseder"])
    expect(result.invalid.code).toBe("supersede_conflict")
  })

  it("rolls back an accompanying note when its supersession edge is invalid", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const failure = yield* Effect.flip(
        store.putNote({
          namespace,
          id: "must-roll-back",
          text: "not durable",
          tags: [],
          provenance: {},
          supersedes: ["missing"]
        })
      )
      const notes = yield* store.listNotes({ namespace, status: "any", includeSuperseded: true })
      return { failure, notes }
    }))

    expect(result.failure.code).toBe("supersede_conflict")
    expect(result.notes).toEqual([])
  })

  it("filters authoritative raw rows by tags, status, and supersession", async () => {
    const rows = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putFact({
        namespace,
        key: "fact-1",
        value: { content: "fact text", tags: ["scope:project"] },
        provenance: {}
      })
      yield* store.putNote({
        namespace,
        id: "note-1",
        text: "note text",
        tags: ["scope:project", "branch:main"],
        provenance: {}
      })
      yield* store.putNote({
        namespace,
        id: "pending",
        text: "not authoritative",
        tags: ["scope:project"],
        provenance: {},
        status: "pending"
      })
      return yield* store.searchRows({
        namespace,
        tagGroups: [
          { tags: ["scope:project"], match: "all_strict" },
          { not: { tags: ["scope:secret"], match: "any_strict" } }
        ]
      })
    }))

    expect(rows.map((row) => [row.kind, row.key, row.text])).toEqual([
      ["fact", "fact-1", "fact text"],
      ["note", "note-1", "note text"]
    ])
    expect(rows.every((row) => row.bank === "flow-project-1")).toBe(true)
  })

  it("fails loudly before FTS enablement, then backfills and updates the per-kind index", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putFact({
        namespace,
        key: "runbook",
        value: { content: "durable checkout recovery", tags: ["scope:project"] },
        provenance: {}
      })
      yield* store.putNote({
        namespace,
        id: "note-fts",
        text: "durable release checklist",
        tags: ["scope:project"],
        provenance: {}
      })
      const disabled = yield* Effect.flip(store.searchFts({ namespace, query: "durable", limit: 10 }))
      yield* store.enableFts("flow")
      const backfilled = yield* store.searchFts({ namespace, query: "durable", limit: 10 })
      yield* store.putFact({
        namespace,
        key: "runbook",
        value: { content: "fresh recovery procedure", tags: ["scope:project"] },
        provenance: {}
      })
      const stale = yield* store.searchFts({ namespace, query: "checkout", limit: 10 })
      const fresh = yield* store.searchFts({ namespace, query: "fresh recovery", limit: 10 })
      const compiled = yield* store.searchFts({
        namespace,
        query: literalFtsQuery("fresh recovery"),
        limit: 10
      })
      return { disabled, backfilled, stale, fresh, compiled }
    }))

    expect(result.disabled.code).toBe("fts_not_enabled")
    expect(result.backfilled.map((row) => row.key).sort()).toEqual(["note-fts", "runbook"])
    expect(result.stale).toEqual([])
    expect(result.fresh.map((row) => row.key)).toEqual(["runbook"])
    expect(result.compiled.map((row) => row.key)).toEqual(["runbook"])
    expect(result.fresh[0]?.rank).toEqual(expect.any(Number))
  })
})
