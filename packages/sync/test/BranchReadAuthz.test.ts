/**
 * The read-path authorization invariant: a branch run is visible only through
 * a capability that verifies for that branch — scoped reads fail, workspace
 * listings and change-follows exclude what the caller cannot read, and a
 * server without a share authority closes every branch run.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal-next"
import * as TestJournal from "@smthrs/journal-next/test/TestJournal"
import { Effect, Fiber, Layer, type Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { type BranchId, branchRunId, type ShareCapability } from "../src/BranchProtocol.ts"
import * as BranchShare from "../src/BranchShare.ts"
import * as RunCatalog from "../src/RunCatalog.ts"
import type { SyncError } from "../src/SyncError.ts"
import * as SyncServer from "../src/SyncServer.ts"

const branchId = "guarded-branch" as BranchId
const branchRun = branchRunId(branchId)
const engineRun = "flows/engine/run-1" as JournalEvent.RunId

const layer = Layer.mergeAll(TestJournal.layer(), BranchShare.layerHmac({ secret: "authz-secret" }))

const program = <A, E>(effect: Effect.Effect<A, E, Journal.Journal | BranchShare.BranchShare | Scope.Scope>) =>
  effect.pipe(Effect.provide(layer), Effect.provide(TestClock.layer()), Effect.scoped)

const writeEntry = (runId: JournalEvent.RunId, text: string) =>
  Effect.flatMap(Journal.Journal, (journal) =>
    journal.emitDurable(
      new JournalEvent.Input({
        runId,
        sourceId: "flows/participant/alice" as JournalEvent.SourceId,
        eventType: "flows/branch/command",
        payload: { text },
        meta: null
      })
    ))

interface Rig {
  readonly server: SyncServer.Service
  readonly bare: SyncServer.Service
  readonly capability: ShareCapability
  readonly foreign: ShareCapability
  readonly register: (runId: JournalEvent.RunId) => Effect.Effect<void>
}

/** A server with a share authority, one without, and capabilities for two branches. */
const rig: Effect.Effect<Rig, never, Journal.Journal | BranchShare.BranchShare> = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  const share = yield* BranchShare.BranchShare
  const memory = yield* RunCatalog.makeMemory()
  const server = yield* SyncServer.makeLive.pipe(
    Effect.provideService(Journal.Journal, journal),
    Effect.provideService(RunCatalog.RunCatalog, memory.catalog),
    Effect.provideService(BranchShare.BranchShare, share)
  )
  const bare = yield* SyncServer.makeLive.pipe(
    Effect.provideService(Journal.Journal, journal),
    Effect.provideService(RunCatalog.RunCatalog, memory.catalog)
  )
  const capability = yield* share.mint({ branchId, capabilityId: "cap", access: "read", ttlMs: 600_000 })
  const foreign = yield* share.mint({
    branchId: "other-branch" as BranchId,
    capabilityId: "foreign",
    access: "read",
    ttlMs: 600_000
  })
  return { server, bare, capability, foreign, register: memory.register }
})

const readBranch = (server: SyncServer.Service, capability?: ShareCapability) =>
  server.read({
    scope: { _tag: "Run", runId: branchRun },
    cursors: [],
    limit: 10,
    ...(capability === undefined ? {} : { capability })
  })

describe("branch read authorization", () => {
  it.effect("fails a scoped branch read without a capability, with a foreign one, and without a share authority", () =>
    Effect.gen(function*() {
      const codes = yield* program(
        Effect.gen(function*() {
          const { server, bare, foreign } = yield* rig
          yield* writeEntry(branchRun, "secret")
          const missing = yield* Effect.flip(readBranch(server))
          const wrong = yield* Effect.flip(readBranch(server, foreign))
          const closed = yield* Effect.flip(readBranch(bare))
          return [missing.code, wrong.code, closed.code]
        })
      )

      expect(codes).toEqual(["unauthorized", "unauthorized", "unauthorized"])
    }))

  it.effect("fails a scoped branch subscription without a capability", () =>
    Effect.gen(function*() {
      const error = yield* program(
        Effect.gen(function*() {
          const { server } = yield* rig
          return yield* Effect.flip(
            Stream.runCollect(server.subscribe({ scope: { _tag: "Run", runId: branchRun }, cursors: [], credit: 1 }))
          )
        })
      )

      expect((error as SyncError).code).toBe("unauthorized")
    }))

  it.effect("serves a scoped branch read to a capability that verifies for the branch", () =>
    Effect.gen(function*() {
      const texts = yield* program(
        Effect.gen(function*() {
          const { server, capability } = yield* rig
          yield* writeEntry(branchRun, "visible to the link holder")
          const response = yield* readBranch(server, capability)
          return response.entries.map((entry) => (entry.payload as { readonly text: string }).text)
        })
      )

      expect(texts).toEqual(["visible to the link holder"])
    }))

  it.effect("excludes unreadable branch runs from a workspace read and includes them with a capability", () =>
    Effect.gen(function*() {
      const [withoutLink, withLink] = yield* program(
        Effect.gen(function*() {
          const { server, capability, register } = yield* rig
          yield* register(engineRun)
          yield* register(branchRun)
          yield* writeEntry(engineRun, "engine")
          yield* writeEntry(branchRun, "branch")
          const denied = yield* server.read({ scope: { _tag: "Workspace" }, cursors: [], limit: 10 })
          const granted = yield* server.read({ scope: { _tag: "Workspace" }, cursors: [], limit: 10, capability })
          return [
            denied.entries.map((entry) => entry.runId),
            granted.entries.map((entry) => entry.runId)
          ]
        })
      )

      expect(withoutLink).toEqual([engineRun])
      expect(withLink).toEqual([branchRun, engineRun])
    }))

  it.effect("filters branch runs out of workspace change-follows without a capability", () =>
    Effect.gen(function*() {
      const frames = yield* program(
        Effect.gen(function*() {
          const { server, register } = yield* rig
          const followed = yield* Stream.runCollect(
            Stream.take(server.subscribe({ scope: { _tag: "Workspace" }, cursors: [], credit: 4 }), 1)
          ).pipe(Effect.forkChild({ startImmediately: true }))
          // Let the subscription attach to the catalog change feed first.
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          // The branch change is advertised first; if it leaked, it would win
          // the race to the one frame this subscription takes.
          yield* writeEntry(branchRun, "must not leak")
          yield* register(branchRun)
          yield* writeEntry(engineRun, "engine change")
          yield* register(engineRun)
          return yield* Effect.map(Fiber.join(followed), (chunk) => Array.from(chunk))
        })
      )

      expect(frames).toHaveLength(1)
      expect(frames[0]?._tag).toBe("Entries")
      expect(frames[0]?._tag === "Entries" ? frames[0].runId : null).toBe(engineRun)
    }))
})
