import * as Jj from "@smthrs/jj"
import { Journal } from "@smthrs/journal"
import { RunStore } from "@smthrs/run-store"
import type { LivenessEvidence, OwnerId } from "@smthrs/run-store/Ownership"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { describe, expect, it } from "vitest"
import * as EffectHandlerRegistry from "../src/EffectHandlerRegistry.ts"
import * as MemoryTimeTravelStore from "../src/MemoryTimeTravelStore.ts"
import * as Recovery from "../src/Recovery.ts"
import type { AuditDetail } from "../src/Rewind.ts"
import { type Audit, TimeTravelStore } from "../src/TimeTravelStore.ts"

/**
 * Startup recovery must arbitrate ownership before it touches a run: an
 * unowned suspended run needs no fence, a claimable run is claimed and
 * activated, a live owner is refused, and a dead owner is only stolen from on
 * explicit liveness evidence. Every refusal has to be typed and must leave the
 * persisted run status exactly as it was found.
 */

const owner: OwnerId = { hostId: "recovery-host", pid: 40, nonce: "recovery-owner" }
const stranger: OwnerId = { hostId: "other-host", pid: 41, nonce: "stranger" }
const frame = { lineageId: "run/root", seq: 0 } as const

const runError = (method: string) =>
  new RunStore.RunStoreError({
    code: "persistence_failed",
    method,
    message: `${method} failed`,
    cause: method
  })

const baseRow = (overrides: Partial<RunStore.RunRow>): RunStore.RunRow => ({
  runId: "run",
  status: "running",
  createdAtMs: 0,
  startedAtMs: 0,
  finishedAtMs: null,
  owner: null,
  heartbeatAtMs: 0,
  claim: null,
  claimedAtMs: null,
  parentRunId: null,
  cancelRequestedAtMs: null,
  stateJson: "{\"cursor\":7}",
  ...overrides
})

const auditRow = (detail?: unknown): Audit => ({
  id: "audit",
  runId: "run",
  frame,
  status: "in_progress",
  detail: detail === undefined
    ? ({
      version: 1,
      phase: "archive_committed",
      originalStatus: "suspended",
      suffixCount: 1,
      suffixTailSeq: 1,
      warnings: [],
      cancelledChildren: []
    } satisfies AuditDetail)
    : detail
})

const emptyJournal = Journal.makeNoop({
  entries: () => Effect.succeed({ entries: [], hasMore: false })
})

const runRecovery = (
  runs: RunStore.Service,
  options: {
    readonly audit?: Audit
    readonly journal?: Journal.Service
    readonly livenessEvidence?: Recovery.Options["livenessEvidence"]
  } = {}
) => {
  const store = MemoryTimeTravelStore.make()
  Effect.runSync(store.writeAudit(options.audit ?? auditRow()))
  const jj = Jj.makeNoop({
    snapshot: () => Effect.succeed({ changeId: "current" }),
    restore: () => Effect.void
  })
  return Effect.runPromise(
    Recovery.recover(
      options.livenessEvidence === undefined
        ? { owner }
        : { owner, livenessEvidence: options.livenessEvidence }
    ).pipe(
      Effect.provide(Layer.succeed(TimeTravelStore, store)),
      Effect.provide(Layer.succeed(RunStore.RunStore, runs)),
      Effect.provide(Layer.succeed(Journal.Journal, options.journal ?? emptyJournal)),
      Effect.provide(Layer.succeed(Jj.Jj, jj)),
      Effect.provide(
        Layer.succeed(EffectHandlerRegistry.EffectHandlerRegistry, EffectHandlerRegistry.makeNoop())
      )
    )
  ).then((outcomes) => ({ outcomes, audits: store.state().audits }))
}

describe("Recovery ownership arbitration", () => {
  it("completes an unowned suspended run without taking a fence", async () => {
    const calls: Array<string> = []
    const runs = RunStore.makeNoop({
      get: () => Effect.succeed(baseRow({ status: "suspended" })),
      claim: () =>
        Effect.sync(() => {
          calls.push("claim")
          return { _tag: "NotFound" as const }
        }),
      transitionOwned: () =>
        Effect.sync(() => {
          calls.push("transitionOwned")
          return { _tag: "Transitioned" as const }
        })
    })

    const { audits, outcomes } = await runRecovery(runs)

    expect(outcomes).toEqual([{ _tag: "Completed", auditId: "audit" }])
    expect(calls).toEqual([])
    expect(audits[0]).toMatchObject({ status: "completed", detail: { phase: "completed" } })
  })

  it("reuses an already-held fence when the run is running under this owner", async () => {
    let transitions = 0
    const runs = RunStore.makeNoop({
      get: () => Effect.succeed(baseRow({ status: "running", owner })),
      transitionOwned: () =>
        Effect.sync(() => {
          transitions += 1
          return { _tag: "Transitioned" as const }
        })
    })

    const { outcomes } = await runRecovery(runs)

    expect(outcomes).toEqual([{ _tag: "Completed", auditId: "audit" }])
    expect(transitions).toBe(1)
  })

  it("claims and activates a pending run before recovering it", async () => {
    const calls: Array<string> = []
    const runs = RunStore.makeNoop({
      get: () => Effect.succeed(baseRow({ status: "pending" })),
      claim: (_runId, _expected, claimant) =>
        Effect.sync(() => {
          calls.push(`claim:${claimant.nonce}`)
          return { _tag: "Claimed" as const, claimedAtMs: 5 }
        }),
      activate: (_runId, _claimant, claimedAtMs) =>
        Effect.sync(() => {
          calls.push(`activate:${claimedAtMs}`)
          return { _tag: "Activated" as const }
        }),
      transitionOwned: () =>
        Effect.sync(() => {
          calls.push("transitionOwned")
          return { _tag: "Transitioned" as const }
        })
    })

    const { outcomes } = await runRecovery(runs)

    expect(outcomes).toEqual([{ _tag: "Completed", auditId: "audit" }])
    expect(calls).toEqual(["claim:recovery-owner", "activate:5", "transitionOwned"])
  })

  it("maps claim and activation persistence failures into terminal outcomes", async () => {
    const scenarios = [
      {
        message: "claim recovery run failed",
        runs: RunStore.makeNoop({
          get: () => Effect.succeed(baseRow({ status: "pending" })),
          claim: () => Effect.fail(runError("claim"))
        })
      },
      {
        message: "activate recovery run failed",
        runs: RunStore.makeNoop({
          get: () => Effect.succeed(baseRow({ status: "pending" })),
          claim: () => Effect.succeed({ _tag: "Claimed" as const, claimedAtMs: 4 }),
          activate: () => Effect.fail(runError("activate"))
        })
      }
    ]

    for (const scenario of scenarios) {
      const { outcomes } = await runRecovery(scenario.runs)
      expect(outcomes[0]).toMatchObject({
        _tag: "Failed",
        error: { code: "unknown", message: scenario.message }
      })
    }
  })

  it("refuses a run that already carries an active claim", async () => {
    const runs = RunStore.makeNoop({
      get: () => Effect.succeed(baseRow({ status: "pending", claim: stranger, claimedAtMs: 3 }))
    })

    const { audits, outcomes } = await runRecovery(runs)

    expect(outcomes[0]).toMatchObject({
      _tag: "Failed",
      error: { code: "busy", message: "run run has an active claim" }
    })
    expect(audits[0]).toMatchObject({ status: "failed", detail: { phase: "terminal_failure" } })
  })

  it("reports a lost claim race as busy without activating", async () => {
    const runs = RunStore.makeNoop({
      get: () => Effect.succeed(baseRow({ status: "pending" })),
      claim: () => Effect.succeed({ _tag: "SnapshotChanged" as const })
    })

    const { outcomes } = await runRecovery(runs)

    expect(outcomes[0]).toMatchObject({
      _tag: "Failed",
      error: { code: "busy", message: "run run could not be claimed for recovery" }
    })
  })

  it("abandons its claim when activation loses the race", async () => {
    const abandoned: Array<number> = []
    const runs = RunStore.makeNoop({
      get: () => Effect.succeed(baseRow({ status: "pending" })),
      claim: () => Effect.succeed({ _tag: "Claimed" as const, claimedAtMs: 9 }),
      activate: () => Effect.succeed({ _tag: "ClaimLost" as const }),
      abandonClaim: (_runId, _claimant, claimedAtMs) =>
        Effect.sync(() => {
          abandoned.push(claimedAtMs)
          return { _tag: "Abandoned" as const }
        })
    })

    const { outcomes } = await runRecovery(runs)

    expect(abandoned).toEqual([9])
    expect(outcomes[0]).toMatchObject({
      _tag: "Failed",
      error: { code: "busy", message: "run run lost its recovery claim" }
    })
  })

  it("refuses to steal from another owner when no liveness probe is configured", async () => {
    const runs = RunStore.makeNoop({
      get: () => Effect.succeed(baseRow({ status: "running", owner: stranger })),
      steal: () => Effect.succeed({ _tag: "Claimed" as const, claimedAtMs: 1 })
    })

    const { outcomes } = await runRecovery(runs)

    expect(outcomes[0]).toMatchObject({
      _tag: "Failed",
      error: { code: "busy", message: "run run is still owned" }
    })
  })

  it("refuses to steal when the probe cannot prove the owner is dead", async () => {
    const runs = RunStore.makeNoop({
      get: () => Effect.succeed(baseRow({ status: "running", owner: stranger })),
      steal: () => Effect.succeed({ _tag: "Claimed" as const, claimedAtMs: 1 })
    })

    const { outcomes } = await runRecovery(runs, { livenessEvidence: () => Effect.succeed(undefined) })

    expect(outcomes[0]).toMatchObject({
      _tag: "Failed",
      error: { code: "busy", message: "run run is still live" }
    })
  })

  it("steals from a proven-dead owner and recovers under the new fence", async () => {
    const stolen: Array<LivenessEvidence> = []
    const runs = RunStore.makeNoop({
      get: () => Effect.succeed(baseRow({ status: "running", owner: stranger })),
      steal: (_runId, _expected, _claimant, _nowMs, evidence) =>
        Effect.sync(() => {
          stolen.push(evidence)
          return { _tag: "Claimed" as const, claimedAtMs: 12 }
        }),
      activate: () => Effect.succeed({ _tag: "Activated" as const }),
      transitionOwned: () => Effect.succeed({ _tag: "Transitioned" as const })
    })

    const { outcomes } = await runRecovery(runs, {
      livenessEvidence: (audit, row, claimant, nowMs) =>
        Effect.succeed({
          expectedOwner: row.owner ?? claimant,
          checkedAtMs: nowMs,
          kind: audit.runId === "run" ? "cross-host-unreachable-stale" : "same-host-pid-dead"
        })
    })

    expect(stolen).toEqual([
      expect.objectContaining({ expectedOwner: stranger, kind: "cross-host-unreachable-stale" })
    ])
    expect(outcomes).toEqual([{ _tag: "Completed", auditId: "audit" }])
  })

  it("maps a failed ownership steal into a terminal outcome", async () => {
    const runs = RunStore.makeNoop({
      get: () => Effect.succeed(baseRow({ status: "running", owner: stranger })),
      steal: () => Effect.fail(runError("steal"))
    })

    const { outcomes } = await runRecovery(runs, {
      livenessEvidence: (_audit, row, claimant, nowMs) =>
        Effect.succeed({
          expectedOwner: row.owner ?? claimant,
          checkedAtMs: nowMs,
          kind: "cross-host-unreachable-stale"
        })
    })

    expect(outcomes[0]).toMatchObject({
      _tag: "Failed",
      error: { code: "unknown", message: "steal recovery run failed" }
    })
  })

  it("propagates a missing run row as a typed not_found terminal failure", async () => {
    const runs = RunStore.makeNoop({
      get: () =>
        Effect.fail(
          new RunStore.RunStoreError({
            code: "not_found_row",
            method: "get",
            message: "no such run",
            cause: undefined
          })
        )
    })

    const { outcomes } = await runRecovery(runs)

    expect(outcomes[0]).toMatchObject({
      _tag: "Failed",
      error: { code: "not_found", message: "read recovery run failed" }
    })
  })

  it("records a terminal failure when the fence is lost mid-recovery", async () => {
    const runs = RunStore.makeNoop({
      get: () => Effect.succeed(baseRow({ status: "running", owner })),
      transitionOwned: () => Effect.succeed({ _tag: "FenceLost" as const })
    })

    const { audits, outcomes } = await runRecovery(runs)

    expect(outcomes[0]).toMatchObject({
      _tag: "Failed",
      error: { code: "busy", message: "run run lost its recovery fence" }
    })
    expect(audits[0]).toMatchObject({ status: "failed", detail: { phase: "terminal_failure" } })
  })

  it("maps suspension and rollback transition persistence failures", async () => {
    const finish = await runRecovery(
      RunStore.makeNoop({
        get: () => Effect.succeed(baseRow({ status: "running", owner })),
        transitionOwned: () => Effect.fail(runError("finish"))
      })
    )
    const rollback = await runRecovery(
      RunStore.makeNoop({
        get: () => Effect.succeed(baseRow({ status: "running", owner })),
        transitionOwned: () => Effect.fail(runError("restore"))
      }),
      {
        audit: auditRow(
          {
            version: 1,
            phase: "compensated",
            originalStatus: "pending",
            suffixCount: 1,
            warnings: [],
            cancelledChildren: []
          } satisfies AuditDetail
        ),
        journal: Journal.makeNoop({
          entries: () =>
            Effect.succeed({
              entries: [{ seq: 1 }] as never,
              hasMore: false
            })
        })
      }
    )

    expect(finish.outcomes[0]).toMatchObject({
      _tag: "Failed",
      error: { code: "unknown", message: "finish recovered suspension failed" }
    })
    expect(rollback.outcomes[0]).toMatchObject({
      _tag: "Failed",
      error: { code: "unknown", message: "restore recovered run failed" }
    })
  })

  it("records a terminal failure when the rollback fence is lost", async () => {
    const runs = RunStore.makeNoop({
      get: () => Effect.succeed(baseRow({ status: "running", owner })),
      transitionOwned: () => Effect.succeed({ _tag: "FenceLost" as const })
    })

    const { outcomes } = await runRecovery(runs, {
      audit: auditRow(
        {
          version: 1,
          phase: "compensated",
          originalStatus: "suspended",
          suffixCount: 1,
          suffixTailSeq: 1,
          warnings: [],
          cancelledChildren: []
        } satisfies AuditDetail
      ),
      journal: Journal.makeNoop({
        entries: () =>
          Effect.succeed({
            entries: [
              {
                runId: "run",
                seq: 1,
                eventId: "event-1",
                sourceId: "recovery",
                sourceSeq: 1,
                emittedAtMs: 1,
                eventType: "suffix",
                payload: {},
                meta: {}
              }
            ] as never,
            hasMore: false
          })
      })
    })

    expect(outcomes[0]).toMatchObject({
      _tag: "Failed",
      error: { code: "busy", message: "run run lost its rollback fence" }
    })
  })

  it("rolls back without consulting the journal when the rewind archived nothing", async () => {
    let entryQueries = 0
    const runs = RunStore.makeNoop({
      get: () => Effect.succeed(baseRow({ status: "suspended" })),
      transitionOwned: () => Effect.succeed({ _tag: "Transitioned" as const })
    })

    const { audits, outcomes } = await runRecovery(runs, {
      audit: auditRow(
        {
          version: 1,
          phase: "compensated",
          originalStatus: "suspended",
          suffixCount: 0,
          warnings: [],
          cancelledChildren: []
        } satisfies AuditDetail
      ),
      journal: Journal.makeNoop({
        entries: () =>
          Effect.sync(() => {
            entryQueries += 1
            return { entries: [], hasMore: false }
          })
      })
    })

    expect(entryQueries).toBe(0)
    expect(outcomes).toEqual([{ _tag: "RolledBack", auditId: "audit" }])
    expect(audits[0]).toMatchObject({ status: "failed", detail: { phase: "rolled_back" } })
  })

  it("treats an already-completed protocol phase as committed", async () => {
    let entryQueries = 0
    const { outcomes } = await runRecovery(
      RunStore.makeNoop({ get: () => Effect.succeed(baseRow({ status: "suspended" })) }),
      {
        audit: auditRow(
          {
            version: 1,
            phase: "completed",
            originalStatus: "suspended",
            suffixCount: 1,
            warnings: [],
            cancelledChildren: []
          } satisfies AuditDetail
        ),
        journal: Journal.makeNoop({
          entries: () =>
            Effect.sync(() => {
              entryQueries += 1
              return { entries: [], hasMore: false }
            })
        })
      }
    )

    expect(outcomes).toEqual([{ _tag: "Completed", auditId: "audit" }])
    expect(entryQueries).toBe(0)
  })

  it("turns an unreadable journal into a typed terminal failure", async () => {
    const runs = RunStore.makeNoop({
      get: () => Effect.succeed(baseRow({ status: "suspended" }))
    })

    const { outcomes } = await runRecovery(runs, {
      audit: auditRow(
        {
          version: 1,
          phase: "compensated",
          originalStatus: "suspended",
          suffixCount: 2,
          warnings: [],
          cancelledChildren: []
        } satisfies AuditDetail
      ),
      journal: Journal.makeNoop()
    })

    expect(outcomes[0]).toMatchObject({
      _tag: "Failed",
      error: { code: "unknown", message: "could not inspect archive commit for audit" }
    })
  })

  it("refuses an audit whose persisted protocol detail is unrecognisable", async () => {
    const runs = RunStore.makeNoop({
      get: () => Effect.succeed(baseRow({ status: "suspended" }))
    })

    const { audits, outcomes } = await runRecovery(runs, {
      audit: auditRow({ version: 2, phase: "archive_committed" })
    })

    expect(outcomes[0]).toMatchObject({
      _tag: "Failed",
      error: { code: "unknown", message: "audit audit has no recoverable protocol detail" }
    })
    expect(audits[0]).toMatchObject({
      status: "failed",
      detail: { phase: "terminal_failure", version: 1 }
    })
  })

  it("rejects every malformed recovery-detail shape independently", async () => {
    for (
      const detail of [
        null,
        [],
        { version: 1 },
        { version: 1, phase: 1, originalStatus: "suspended", suffixCount: 1, warnings: [], cancelledChildren: [] },
        {
          version: 1,
          phase: "compensated",
          originalStatus: "running",
          suffixCount: 1,
          warnings: [],
          cancelledChildren: []
        },
        {
          version: 1,
          phase: "compensated",
          originalStatus: "pending",
          suffixCount: "1",
          warnings: [],
          cancelledChildren: []
        },
        {
          version: 1,
          phase: "compensated",
          originalStatus: "pending",
          suffixCount: 1,
          warnings: {},
          cancelledChildren: []
        },
        {
          version: 1,
          phase: "compensated",
          originalStatus: "pending",
          suffixCount: 1,
          warnings: [],
          cancelledChildren: {}
        }
      ]
    ) {
      const { outcomes } = await runRecovery(
        RunStore.makeNoop({ get: () => Effect.succeed(baseRow({ status: "suspended" })) }),
        { audit: auditRow(detail) }
      )
      expect(outcomes[0]).toMatchObject({
        _tag: "Failed",
        error: { code: "unknown", message: "audit audit has no recoverable protocol detail" }
      })
    }
  })

  it("normalizes a non-Error recovery defect", async () => {
    const { outcomes } = await runRecovery(
      RunStore.makeNoop({ get: () => Effect.succeed(baseRow({ status: "running", owner: stranger })) }),
      { livenessEvidence: () => Effect.die("recovery-defect") }
    )

    expect(outcomes[0]).toMatchObject({
      _tag: "Failed",
      error: { code: "unknown", message: "recovery-defect" }
    })
  })

  it("normalizes an Error recovery defect using its message", async () => {
    const { outcomes } = await runRecovery(
      RunStore.makeNoop({ get: () => Effect.succeed(baseRow({ status: "running", owner: stranger })) }),
      { livenessEvidence: () => Effect.die(new Error("recovery-error")) }
    )

    expect(outcomes[0]).toMatchObject({
      _tag: "Failed",
      error: { code: "unknown", message: "recovery-error" }
    })
  })
})
