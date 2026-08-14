/**
 * The multiplayer invariants, end to end over the real server and client: two
 * independently instantiated clients on one branch converge, and a reconnect
 * resumes from the canonical cursor without gaps or replayed side effects.
 *
 * @since 0.1.0
 */
import { Journal } from "@smthrs/journal-next"
import * as TestJournal from "@smthrs/journal-next/test/TestJournal"
import { Effect, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as BranchCommands from "../src/BranchCommands.ts"
import * as BranchProjection from "../src/BranchProjection.ts"
import * as BranchProtocol from "../src/BranchProtocol.ts"
import * as BranchShare from "../src/BranchShare.ts"
import * as RunCatalog from "../src/RunCatalog.ts"
import * as SyncClient from "../src/SyncClient.ts"
import * as SyncServer from "../src/SyncServer.ts"

const branchId = "live-branch" as BranchProtocol.BranchId
const runId = BranchProtocol.branchRunId(branchId)
const scope = { _tag: "Run", runId } as const
const alice = "alice" as BranchProtocol.ParticipantId
const bob = "bob" as BranchProtocol.ParticipantId

const layer = Layer.mergeAll(
  TestJournal.layer(),
  BranchShare.layerHmac({ secret: "convergence-secret" }),
  RunCatalog.layerStatic([runId])
)

const run = <A, E>(
  effect: Effect.Effect<A, E, Journal.Journal | BranchShare.BranchShare | RunCatalog.RunCatalog>
) => Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(TestClock.layer())))

/**
 * One browser client: its own cursor state over a shared server, which is what
 * makes "two clients converge" a claim about replication rather than about two
 * views of one in-process object.
 */
const client = (server: SyncServer.Service) =>
  Effect.runSync(SyncClient.make({
    client: {
      "Sync.Read": server.read,
      "Sync.Subscribe": server.subscribe
    } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
  }))

const collect = (
  sync: SyncClient.Service,
  count: number,
  capability: BranchProtocol.ShareCapability
) => Stream.runCollect(Stream.take(sync.subscribe({ scope, cursors: [], capability }), count))

describe("branch convergence", () => {
  it("converges two independently instantiated clients on one ordered projection", async () => {
    const [left, right, seqs] = await run(
      Effect.gen(function*() {
        const server = yield* SyncServer.makeLive
        const commands = yield* BranchCommands.makeLive
        const capability = yield* Effect.flatMap(
          BranchShare.BranchShare,
          (share) => share.mint({ branchId, capabilityId: "cap", access: "write", ttlMs: 600_000 })
        )
        const say = (participantId: BranchProtocol.ParticipantId, id: string, text: string) =>
          commands.submit({
            capability,
            submission: BranchCommands.submission({
              branchId,
              commandId: id as BranchProtocol.CommandId,
              participantId,
              name: BranchProtocol.SayCommand,
              args: text
            })
          })
        yield* say(alice, "c1", "opening the branch")
        yield* say(bob, "c2", "joined from another tab")
        yield* say(alice, "c3", "renaming next")
        yield* commands.submit({
          capability,
          submission: BranchCommands.submission({
            branchId,
            commandId: "c4" as BranchProtocol.CommandId,
            participantId: bob,
            name: "branch.rename",
            args: "Shared branch",
            target: "title"
          })
        })

        const entriesLeft = yield* collect(client(server), 4, capability)
        const entriesRight = yield* collect(client(server), 4, capability)
        return [
          BranchProjection.project(branchId, entriesLeft),
          BranchProjection.project(branchId, entriesRight),
          Array.from(entriesLeft, (entry) => entry.seq)
        ]
      })
    )

    expect(left).toEqual(right)
    expect(left.messages.map((message) => message.text)).toEqual([
      "opening the branch",
      "joined from another tab",
      "renaming next"
    ])
    expect(left.fields).toEqual([{ target: "title", value: "Shared branch", seq: left.seq, participantId: bob }])
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
  })

  it("resumes a reconnect from the canonical cursor with no gap and no replay", async () => {
    const [beforeDrop, afterReconnect, resumedSeqs, cursors] = await run(
      Effect.gen(function*() {
        const server = yield* SyncServer.makeLive
        const commands = yield* BranchCommands.makeLive
        const capability = yield* Effect.flatMap(
          BranchShare.BranchShare,
          (share) => share.mint({ branchId, capabilityId: "cap", access: "write", ttlMs: 600_000 })
        )
        const say = (id: string, text: string) =>
          commands.submit({
            capability,
            submission: BranchCommands.submission({
              branchId,
              commandId: id as BranchProtocol.CommandId,
              participantId: alice,
              name: BranchProtocol.SayCommand,
              args: text
            })
          })
        yield* say("c1", "first")
        yield* say("c2", "second")

        const sync = client(server)
        const firstPass = yield* collect(sync, 2, capability)
        const partial = BranchProjection.project(branchId, firstPass)

        // The connection drops here; the branch keeps moving without us.
        yield* say("c3", "sent while disconnected")
        const resumed = yield* collect(sync, 1, capability)
        return [
          partial,
          Array.from(resumed).reduce(BranchProjection.apply, partial),
          Array.from(resumed, (entry) => entry.seq),
          yield* sync.cursors
        ]
      })
    )

    expect(beforeDrop.messages.map((message) => message.text)).toEqual(["first", "second"])
    expect(afterReconnect.messages.map((message) => message.text)).toEqual([
      "first",
      "second",
      "sent while disconnected"
    ])
    expect(resumedSeqs).toHaveLength(1)
    expect(cursors).toEqual([{ runId, afterSeq: afterReconnect.seq }])
  })

  it("holds a duplicate submission to one applied command across both clients", async () => {
    const [projections, entryCount] = await run(
      Effect.gen(function*() {
        const server = yield* SyncServer.makeLive
        const commands = yield* BranchCommands.makeLive
        const capability = yield* Effect.flatMap(
          BranchShare.BranchShare,
          (share) => share.mint({ branchId, capabilityId: "cap", access: "write", ttlMs: 600_000 })
        )
        const request = {
          capability,
          submission: BranchCommands.submission({
            branchId,
            commandId: "optimistic" as BranchProtocol.CommandId,
            participantId: alice,
            name: BranchProtocol.SayCommand,
            args: "sent once, retried twice"
          })
        }
        yield* commands.submit(request)
        yield* commands.submit(request)
        yield* commands.submit(request)
        const journal = yield* Journal.Journal
        const page = yield* journal.entries({ runId, limit: 10 })
        return [
          [
            BranchProjection.project(branchId, yield* collect(client(server), 1, capability)),
            BranchProjection.project(branchId, yield* collect(client(server), 1, capability))
          ],
          page.entries.length
        ]
      })
    )

    expect(entryCount).toBe(1)
    expect(projections[0]).toEqual(projections[1])
    expect(projections[0]?.messages).toHaveLength(1)
  })
})
