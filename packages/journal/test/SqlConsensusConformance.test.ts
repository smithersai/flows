/**
 * The shared consensus conformance contract instantiated for the default
 * database-backed strategy, whose lease lives in `flows_consensus_leases` and
 * whose guard joins the append transaction.
 */
import { describe, expect, it } from "@effect/vitest"
import type { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Duration, Effect, Layer } from "effect"
import type * as Scope from "effect/Scope"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { Consensus, heartbeatStaleAfter, type LivenessEvidence } from "../src/Consensus.ts"
import * as Migrations from "../src/Migrations.ts"
import type { OwnerId } from "../src/OwnerId.ts"
import * as SqlConsensus from "../src/SqlConsensus.ts"
import { conformance } from "./ConsensusConformance.ts"

conformance("SqlConsensus.layer", SqlConsensus.layer)

const ownerA: OwnerId = { hostId: "host-a", pid: 101, nonce: "owner-a" }
const ownerB: OwnerId = { hostId: "host-b", pid: 202, nonce: "owner-b" }
const ownerC: OwnerId = { hostId: "host-c", pid: 303, nonce: "owner-c" }
const staleAfterMs = Duration.toMillis(heartbeatStaleAfter)

const evidence = (
  expectedOwner: OwnerId,
  claimant: OwnerId,
  checkedAtMs: number
): LivenessEvidence => ({
  expectedOwner,
  checkedAtMs,
  kind: expectedOwner.hostId === claimant.hostId ? "same-host-pid-dead" : "cross-host-unreachable-stale"
})

const stack = SqlConsensus.layer.pipe(
  Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer))
)

const withStack = <A, E>(
  body: Effect.Effect<A, E, Consensus | DurableWriter | Scope.Scope | SqlClient.SqlClient>
) => Effect.scoped(body.pipe(Effect.provide(stack)))

const createLegacyRuns = Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  sql`
    CREATE TABLE flows_runs (
      run_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      owner_host_id TEXT,
      owner_pid INTEGER,
      owner_nonce TEXT,
      heartbeat_at_ms INTEGER,
      claim_host_id TEXT,
      claim_pid INTEGER,
      claim_nonce TEXT,
      claimed_at_ms INTEGER
    )
  `)

describe("SqlConsensus legacy lease backfill compatibility", () => {
  it.effect("steals a stale legacy owner even when the lease row was not backfilled", () =>
    withStack(Effect.gen(function*() {
      const consensus = yield* Consensus
      const sql = yield* Effect.service(SqlClient.SqlClient)
      const nowMs = staleAfterMs + 1

      yield* createLegacyRuns
      yield* sql`
        INSERT INTO flows_runs (
          run_id, status, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms
        ) VALUES (
          'legacy-running', 'running',
          ${ownerA.hostId}, ${ownerA.pid}, ${ownerA.nonce}, 0
        )
      `

      expect(yield* consensus.steal("legacy-running", ownerB, nowMs, evidence(ownerA, ownerB, nowMs))).toEqual({
        _tag: "Claimed",
        grantedAtMs: nowMs
      })
    })))

  it.effect("rejects a lease-less steal when no legacy row proves stale ownership", () =>
    withStack(Effect.gen(function*() {
      const consensus = yield* Consensus
      const nowMs = staleAfterMs + 1

      yield* createLegacyRuns

      expect(yield* consensus.steal("legacy-missing", ownerB, nowMs, evidence(ownerA, ownerB, nowMs))).toEqual({
        _tag: "Rejected",
        reason: "evidence_invalid"
      })
    })))

  it.effect("recovers stale legacy claims and classifies fresh or changed claims", () =>
    withStack(Effect.gen(function*() {
      const consensus = yield* Consensus
      const sql = yield* Effect.service(SqlClient.SqlClient)
      const staleNowMs = staleAfterMs + 1

      yield* createLegacyRuns
      yield* sql`
        INSERT INTO flows_runs (
          run_id, status, claim_host_id, claim_pid, claim_nonce, claimed_at_ms
        ) VALUES (
          'legacy-stale-claim', 'pending',
          ${ownerA.hostId}, ${ownerA.pid}, ${ownerA.nonce}, 0
        ), (
          'legacy-fresh-claim', 'pending',
          ${ownerB.hostId}, ${ownerB.pid}, ${ownerB.nonce}, ${staleAfterMs}
        )
      `

      expect(
        yield* consensus.recover(
          "legacy-stale-claim",
          ownerA,
          0,
          ownerC,
          staleNowMs,
          evidence(ownerA, ownerC, staleNowMs)
        )
      ).toEqual({ _tag: "Recovered" })
      expect(
        yield* consensus.recover(
          "legacy-fresh-claim",
          ownerB,
          staleAfterMs,
          ownerC,
          staleAfterMs,
          evidence(ownerB, ownerC, staleAfterMs)
        )
      ).toEqual({ _tag: "Rejected", reason: "claim_fresh" })
      expect(
        yield* consensus.recover(
          "legacy-missing-claim",
          ownerA,
          0,
          ownerC,
          staleNowMs,
          evidence(ownerA, ownerC, staleNowMs)
        )
      ).toEqual({ _tag: "Rejected", reason: "claim_changed" })
    })))

  it.effect("classifies a lease-less recovery without the legacy table as changed", () =>
    withStack(Effect.gen(function*() {
      const consensus = yield* Consensus
      const nowMs = staleAfterMs + 1

      expect(yield* consensus.recover("no-legacy-table", ownerA, 0, ownerC, nowMs, evidence(ownerA, ownerC, nowMs)))
        .toEqual({ _tag: "Rejected", reason: "claim_changed" })
    })))
})
