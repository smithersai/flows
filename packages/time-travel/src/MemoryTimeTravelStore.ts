import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { Frame, LineageEdge } from "./Frame.ts"
import { error, TimeTravelError } from "./TimeTravelError.ts"
import * as TimeTravelStore from "./TimeTravelStore.ts"

/** @since 0.1.0 @category models */
export interface JournalRecord {
  readonly runId: string
  readonly seq: number
  readonly eventId: string
  readonly lineageId: string
  readonly payload: unknown
  /**
   * The engine record type this stands in for, when a test drives the derived
   * reads. Absent means "some other record", which the folds skip.
   */
  readonly eventType?: string | undefined
}
/** @since 0.1.0 @category models */
export interface MemoryState {
  readonly records: ReadonlyArray<JournalRecord>
  readonly archived: ReadonlyArray<JournalRecord>
  readonly edges: ReadonlyArray<LineageEdge>
  readonly audits: ReadonlyArray<TimeTravelStore.Audit>
  readonly receipts: ReadonlyArray<TimeTravelStore.Receipt>
  readonly snapshots: ReadonlyArray<TimeTravelStore.Snapshot>
  readonly liveRuns: ReadonlySet<string>
}
/** @since 0.1.0 @category models */
export interface Options {
  readonly records?: ReadonlyArray<JournalRecord>
  readonly edges?: ReadonlyArray<LineageEdge>
  readonly snapshots?: ReadonlyArray<TimeTravelStore.Snapshot>
  readonly liveRuns?: ReadonlySet<string>
  readonly failAt?: string
}

const descendantsFrom = (
  edges: ReadonlyArray<LineageEdge>,
  runId: string,
  frame: Frame
): {
  readonly attached: ReadonlyArray<LineageEdge>
  readonly detached: ReadonlyArray<LineageEdge>
  readonly attachedRunIds: ReadonlySet<string>
} => {
  const attached: Array<LineageEdge> = []
  const detached: Array<LineageEdge> = []
  const attachedRunIds = new Set<string>()
  const detachedRunIds = new Set<string>()
  const queue: Array<string> = []

  const include = (edge: LineageEdge): void => {
    if (edge.attached) {
      if (attachedRunIds.has(edge.childRunId)) return
      attached.push(edge)
      attachedRunIds.add(edge.childRunId)
      queue.push(edge.childRunId)
    } else {
      if (detachedRunIds.has(edge.childRunId)) return
      detached.push(edge)
      detachedRunIds.add(edge.childRunId)
    }
  }

  for (const edge of edges) {
    if (edge.parentRunId === runId && edge.parentSeq > frame.seq) include(edge)
  }
  while (queue.length > 0) {
    const parentRunId = queue.shift()!
    for (const edge of edges) {
      if (edge.parentRunId === parentRunId) include(edge)
    }
  }

  return { attached, detached, attachedRunIds }
}

/** @since 0.1.0 @category constructors */
export const make = (options: Options = {}): TimeTravelStore.Service & { readonly state: () => MemoryState } => {
  let records = [...(options.records ?? [])]
  let archived: Array<JournalRecord> = []
  let edges = [...(options.edges ?? [])]
  let audits: Array<TimeTravelStore.Audit> = []
  let receipts: Array<TimeTravelStore.Receipt> = []
  let snapshots = [...(options.snapshots ?? [])]
  const liveRuns = new Set(options.liveRuns ?? [])
  let sequence = 0
  const fail = (step: string): void => {
    if (options.failAt === step) throw error("unknown", `injected failure at ${step}`)
  }
  const state = (): MemoryState => ({
    records: [...records],
    archived: [...archived],
    edges: [...edges],
    audits: [...audits],
    receipts: [...receipts],
    snapshots: [...snapshots],
    liveRuns: new Set(liveRuns)
  })
  /** The lineage-filtered prefix of one record type, mirroring the SQL store. */
  const framed = (
    runId: string,
    frame: Frame,
    eventType: string
  ): ReadonlyArray<JournalRecord> =>
    records
      .filter((record) =>
        record.runId === runId &&
        record.seq <= frame.seq &&
        record.eventType === eventType &&
        record.lineageId === frame.lineageId
      )
      .sort((left, right) => left.seq - right.seq)
  const atomic = <A>(body: () => A): Effect.Effect<A, TimeTravelError> =>
    Effect.try({
      try: () => {
        const before = state()
        const beforeSequence = sequence
        try {
          return body()
        } catch (cause) {
          records = [...before.records]
          archived = [...before.archived]
          edges = [...before.edges]
          audits = [...before.audits]
          receipts = [...before.receipts]
          snapshots = [...before.snapshots]
          liveRuns.clear()
          for (const runId of before.liveRuns) liveRuns.add(runId)
          sequence = beforeSequence
          throw cause
        }
      },
      catch: (cause) =>
        cause instanceof TimeTravelError
          ? cause
          : error("unknown", "memory transaction failed", cause)
    })
  const service = TimeTravelStore.make({
    snapshotAt: Effect.fn("TimeTravelStore.snapshotAt")((runId, frame) =>
      Effect.sync(() =>
        snapshots.filter((snapshot) =>
          snapshot.runId === runId && snapshot.frame.lineageId === frame.lineageId && snapshot.frame.seq <= frame.seq
        ).sort((a, b) => b.frame.seq - a.frame.seq)[0]
      )
    ),
    recordSnapshot: Effect.fn("TimeTravelStore.recordSnapshot")((snapshot) =>
      atomic(() => {
        fail("recordSnapshot")
        snapshots = [
          ...snapshots.filter((existing) =>
            !(
              existing.runId === snapshot.runId &&
              existing.frame.lineageId === snapshot.frame.lineageId &&
              existing.frame.seq === snapshot.frame.seq
            )
          ),
          snapshot
        ]
      })
    ),
    stateAt: Effect.fn("TimeTravelStore.stateAt")((runId, frame) =>
      Effect.sync(() => {
        let state: unknown = undefined
        for (const record of framed(runId, frame, "flows.engine.run-decision")) {
          const payload = record.payload as { readonly state?: unknown } | null
          if (payload !== null && payload !== undefined && payload.state !== undefined) state = payload.state
        }
        return state === undefined ? undefined : JSON.stringify(state)
      })
    ),
    attemptsAt: Effect.fn("TimeTravelStore.attemptsAt")((runId, frame) =>
      Effect.sync(() => {
        const refs = new Map<string, TimeTravelStore.AttemptRef>()
        for (const record of framed(runId, frame, "flows.engine.attempt-started")) {
          const payload = record.payload as
            | { readonly stepKeyDigest?: unknown; readonly attempt?: unknown }
            | null
          if (typeof payload?.stepKeyDigest !== "string" || typeof payload.attempt !== "number") continue
          refs.set(`${payload.stepKeyDigest}:${payload.attempt}`, {
            stepKeyDigest: payload.stepKeyDigest,
            attempt: payload.attempt
          })
        }
        return [...refs.values()]
      })
    ),
    descendants: Effect.fn("TimeTravelStore.descendants")((runId, frame) =>
      Effect.sync(() => {
        const descendants = descendantsFrom(edges, runId, frame)
        return { attached: descendants.attached, detached: descendants.detached }
      })
    ),
    writeAudit: Effect.fn("TimeTravelStore.writeAudit")((audit) =>
      atomic(() => {
        fail("writeAudit")
        audits.push(audit)
      })
    ),
    updateAudit: Effect.fn("TimeTravelStore.updateAudit")((id, patch) =>
      atomic(() => {
        fail("updateAudit")
        const index = audits.findIndex((audit) => audit.id === id)
        if (index < 0) throw error("not_found", `audit ${id} was not found`)
        audits[index] = { ...audits[index]!, ...patch }
      })
    ),
    pendingAudits: Effect.fn("TimeTravelStore.pendingAudits")(() =>
      Effect.sync(() => audits.filter((audit) => audit.status === "in_progress"))
    ),
    archiveAndTruncate: Effect.fn("TimeTravelStore.archiveAndTruncate")((runId, frame, newReceipts) =>
      atomic(() => {
        fail("archiveAndTruncate:start")
        const descendants = descendantsFrom(edges, runId, frame)
        const doomed = records.filter((record) =>
          (record.runId === runId && record.seq > frame.seq) ||
          descendants.attachedRunIds.has(record.runId)
        )
        fail("archiveAndTruncate:before-archive")
        archived.push(...doomed)
        fail("archiveAndTruncate:before-truncate")
        records = records.filter((record) =>
          !(
            (record.runId === runId && record.seq > frame.seq) ||
            descendants.attachedRunIds.has(record.runId)
          )
        )
        const attachedChildren = new Set(descendants.attached.map((edge) => edge.childRunId))
        edges = edges.filter((edge) => !attachedChildren.has(edge.childRunId))
        receipts.push(...newReceipts)
        fail("archiveAndTruncate:commit")
        return { archived: doomed.length, orphaned: descendants.detached }
      })
    ),
    createFork: Effect.fn("TimeTravelStore.createFork")((parentRunId, frame) =>
      atomic(() => {
        fail("createFork:start")
        let currentRunId: string | undefined = parentRunId
        const seen = new Set<string>()
        while (currentRunId !== undefined && !seen.has(currentRunId)) {
          seen.add(currentRunId)
          if (liveRuns.has(currentRunId)) {
            throw error("live_parent", `ancestor run ${currentRunId} is live`)
          }
          currentRunId = edges.find((edge) => edge.childRunId === currentRunId)?.parentRunId
        }
        const runId = `${parentRunId}:fork:${++sequence}`
        const prefix = records.filter((record) => record.runId === parentRunId && record.seq <= frame.seq)
        fail("createFork:copy")
        records.push(...prefix.map((record) => ({ ...record, runId, eventId: `fork:${runId}:${record.seq}` })))
        const edge: LineageEdge = {
          parentRunId,
          parentSeq: frame.seq,
          childRunId: runId,
          kind: "fork",
          attached: false
        }
        edges.push(edge)
        fail("createFork:commit")
        return { runId, edge, warnings: [] }
      })
    ),
    recordReceipt: Effect.fn("TimeTravelStore.recordReceipt")((receipt) =>
      atomic(() => {
        fail("recordReceipt")
        receipts.push(receipt)
      })
    )
  })
  return Object.assign(service, { state })
}
/** @since 0.1.0 @category layers */
export const layer = (options: Options = {}): Layer.Layer<TimeTravelStore.TimeTravelStore> =>
  Layer.succeed(TimeTravelStore.TimeTravelStore)(make(options))
