/**
 * End-to-end coverage for the branch collaboration RPC group: share-link
 * minting, idempotent command admission, presence announce/leave/roster, and
 * the roster watch stream, all over a real RPC client/server round trip.
 *
 * @since 0.1.0
 */
import { Journal } from "@smthrs/journal-next"
import * as TestJournal from "@smthrs/journal-next/test/TestJournal"
import { Deferred, Effect, Fiber, Layer, Option, Queue, type Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import type * as RpcClientError from "effect/unstable/rpc/RpcClientError"
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup"
import type { FromServerEncoded } from "effect/unstable/rpc/RpcMessage"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as RpcServer from "effect/unstable/rpc/RpcServer"
import * as Socket from "effect/unstable/socket/Socket"
import { describe, expect, it } from "vitest"
import * as BranchCommands from "../src/BranchCommands.ts"
import * as BranchIds from "../src/BranchIds.ts"
import * as BranchPresence from "../src/BranchPresence.ts"
import {
  type BranchId,
  branchRunId,
  type CommandId,
  Cursor,
  type ParticipantId,
  SayCommand
} from "../src/BranchProtocol.ts"
import * as BranchRpcs from "../src/BranchRpcs.ts"
import * as BranchServer from "../src/BranchServer.ts"
import * as BranchShare from "../src/BranchShare.ts"
import * as TestSocket from "../src/test/TestSocket.ts"

const base = Layer.mergeAll(TestJournal.layer(), BranchShare.layerHmac({ secret: "wire-secret" }), BranchIds.layer)
const services = Layer.mergeAll(BranchPresence.layer({ leaseMs: 600_000 }), BranchCommands.layer).pipe(
  Layer.provide(base)
)
const layer = Layer.mergeAll(base, services)

type Requirements =
  | Journal.Journal
  | BranchShare.BranchShare
  | BranchPresence.BranchPresence
  | BranchCommands.BranchCommands
  | BranchIds.BranchIds
  | Scope.Scope

const program = <A, E>(effect: Effect.Effect<A, E, Requirements>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(TestClock.layer()), Effect.scoped))

type Client = RpcClient.RpcClient<RpcGroup.Rpcs<typeof BranchRpcs.BranchRpcs>, RpcClientError.RpcClientError>

/**
 * One RPC client over a fresh in-memory socket pair.
 *
 * The server end runs the real schema-aware protocol (`RpcServer.make` over a
 * hand-rolled `Protocol` bound to the socket pair), so typed failures decode
 * on the client exactly as they would over a hosted transport.
 */
const connect = (pair: TestSocket.Pair): Effect.Effect<Client, never, Requirements> =>
  Effect.gen(function*() {
    const handlers = yield* Layer.build(BranchServer.layerHandlers)
    const serialization = RpcSerialization.json.makeUnsafe()
    const writer = yield* pair.server.writer
    const protocol = yield* RpcServer.Protocol.make((writeRequest) =>
      Effect.gen(function*() {
        yield* pair.server.runRaw((bytes) =>
          Effect.forEach(serialization.decode(bytes), (message) => writeRequest(0, message as never), {
            discard: true
          })
        ).pipe(Effect.forkScoped)
        return {
          disconnects: yield* Queue.make<number>(),
          send: (_clientId: number, response: FromServerEncoded) => {
            const encoded = serialization.encode(response)
            return encoded === undefined ? Effect.void : Effect.orDie(writer(encoded))
          },
          end: () => Effect.void,
          clientIds: Effect.succeed<ReadonlySet<number>>(new Set([0])),
          initialMessage: Effect.succeed(Option.none()),
          supportsAck: true,
          supportsTransferables: false,
          supportsSpanPropagation: false
        }
      })
    )
    yield* RpcServer.make(BranchRpcs.BranchRpcs, { disableFatalDefects: true }).pipe(
      Effect.provideService(RpcServer.Protocol, protocol),
      Effect.provide(handlers),
      Effect.forkScoped
    )
    const clientProtocol = yield* RpcClient.makeProtocolSocket().pipe(
      Effect.provideService(Socket.Socket, pair.client),
      Effect.provide(RpcSerialization.layerJson)
    )
    return yield* RpcClient.make(BranchRpcs.BranchRpcs).pipe(
      Effect.provideService(RpcClient.Protocol, clientProtocol)
    )
  })

const alice = "alice" as ParticipantId
const bob = "bob" as ParticipantId

const say = (
  branchId: BranchId,
  participantId: ParticipantId,
  commandId: string,
  text: string
): BranchRpcs.SubmitPayload["submission"] =>
  BranchCommands.submission({
    branchId,
    commandId: commandId as CommandId,
    participantId,
    name: SayCommand,
    args: text
  })

describe("BranchRpcs over the wire", () => {
  it("creates a branch and admits commands idempotently", async () => {
    const [first, second, journalLength] = await program(
      Effect.gen(function*() {
        const pair = yield* TestSocket.makePair()
        const client = yield* connect(pair)
        const created = yield* client["Branch.CreateBranch"]({ ttlMs: 600_000 })
        const submission = say(created.branchId, alice, "cmd-1", "hello branch")
        const admitted = yield* client["Branch.Submit"]({ capability: created.capability, submission })
        const duplicate = yield* client["Branch.Submit"]({ capability: created.capability, submission })
        const journal = yield* Journal.Journal
        const page = yield* journal.entries({ runId: branchRunId(created.branchId), limit: 10 })
        return [admitted, duplicate, page.entries.length]
      })
    )

    expect(first.status).toBe("admitted")
    expect(second.status).toBe("duplicate")
    expect(second.seq).toBe(first.seq)
    expect(journalLength).toBe(1)
  })

  it("rejects a tampered capability and a write through a read-only link", async () => {
    const [tampered, readOnly] = await program(
      Effect.gen(function*() {
        const pair = yield* TestSocket.makePair()
        const client = yield* connect(pair)
        const created = yield* client["Branch.CreateBranch"]({ ttlMs: 600_000 })
        const readLink = yield* client["Branch.MintShare"]({
          capability: created.capability,
          access: "read",
          ttlMs: 60_000
        })
        const tamperedError = yield* Effect.flip(
          client["Branch.Submit"]({
            capability: { ...created.capability, signature: "00" },
            submission: say(created.branchId, alice, "cmd-t", "forgery")
          })
        )
        const readOnlyError = yield* Effect.flip(
          client["Branch.Submit"]({
            capability: readLink,
            submission: say(created.branchId, bob, "cmd-r", "readers cannot write")
          })
        )
        return [tamperedError, readOnlyError]
      })
    )

    expect(tampered).toMatchObject({ code: "unauthorized" })
    expect(readOnly).toMatchObject({ code: "unauthorized" })
  })

  it("clamps a minted link to the minter's own expiry", async () => {
    const [linkExpiry, ownerExpiry] = await program(
      Effect.gen(function*() {
        const pair = yield* TestSocket.makePair()
        const client = yield* connect(pair)
        const created = yield* client["Branch.CreateBranch"]({ ttlMs: 60_000 })
        const link = yield* client["Branch.MintShare"]({
          capability: created.capability,
          access: "write",
          ttlMs: 600_000
        })
        return [link.claims.expiresAtMs, created.capability.claims.expiresAtMs]
      })
    )

    expect(linkExpiry).toBeLessThanOrEqual(ownerExpiry)
  })

  it("refuses to mint from a read-only capability", async () => {
    const error = await program(
      Effect.gen(function*() {
        const pair = yield* TestSocket.makePair()
        const client = yield* connect(pair)
        const created = yield* client["Branch.CreateBranch"]({ ttlMs: 600_000 })
        const readLink = yield* client["Branch.MintShare"]({
          capability: created.capability,
          access: "read",
          ttlMs: 60_000
        })
        return yield* Effect.flip(
          client["Branch.MintShare"]({ capability: readLink, access: "read", ttlMs: 60_000 })
        )
      })
    )

    expect(error).toMatchObject({ code: "unauthorized" })
  })

  it("tracks join, cursor movement, and leave over the roster watch", async () => {
    const emissions = await program(
      Effect.gen(function*() {
        const pair = yield* TestSocket.makePair()
        const client = yield* connect(pair)
        const created = yield* client["Branch.CreateBranch"]({ ttlMs: 600_000 })
        const capability = created.capability
        const branchId = created.branchId

        // Both participants announce BEFORE the watch starts, so the first
        // emission is a deterministic snapshot rather than a race against the
        // watcher's initial list. The gate orders the leave AFTER the watch
        // has emitted that snapshot, so the second emission is the re-list the
        // leave's presence change triggers.
        yield* client["Branch.Announce"]({
          capability,
          branchId,
          participantId: alice,
          displayName: "Alice",
          cursor: null
        })
        yield* client["Branch.Announce"]({
          capability,
          branchId,
          participantId: bob,
          displayName: "Bob",
          cursor: new Cursor({ cardId: "branch-card", offset: 12 })
        })

        const gate = yield* Deferred.make<void>()
        const watched = yield* Stream.runCollect(
          Stream.take(
            client["Branch.WatchRoster"]({ capability, branchId }).pipe(
              Stream.tap(() => Deferred.succeed(gate, undefined))
            ),
            2
          )
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(gate)
        yield* client["Branch.Leave"]({ capability, branchId, participantId: alice })
        return yield* Fiber.join(watched)
      })
    )

    const rosters = Array.from(emissions, (frame) => frame.participants)
    expect(rosters.map((roster) => roster.map((participant) => participant.participantId))).toEqual([
      [alice, bob],
      [bob]
    ])
    const bobSighting = rosters[0]?.[1]
    expect(bobSighting?.displayName).toBe("Bob")
    expect(bobSighting?.cursor).toMatchObject({ cardId: "branch-card", offset: 12 })
  })

  it("denies the roster to a capability for another branch and to an expired one", async () => {
    const [foreign, expired] = await program(
      Effect.gen(function*() {
        const pair = yield* TestSocket.makePair()
        const client = yield* connect(pair)
        const first = yield* client["Branch.CreateBranch"]({ ttlMs: 600_000 })
        const second = yield* client["Branch.CreateBranch"]({ ttlMs: 600_000 })
        const foreignError = yield* Effect.flip(
          client["Branch.Roster"]({ capability: second.capability, branchId: first.branchId })
        )
        const expiring = yield* client["Branch.CreateBranch"]({ ttlMs: 1 })
        yield* TestClock.adjust(600_000)
        const expiredError = yield* Effect.flip(
          client["Branch.Roster"]({ capability: expiring.capability, branchId: expiring.branchId })
        )
        return [foreignError, expiredError]
      })
    )

    expect(foreign).toMatchObject({ code: "unauthorized" })
    expect(expired).toMatchObject({ code: "unauthorized" })
  })
})
