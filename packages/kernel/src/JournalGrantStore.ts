/**
 * Journal-backed persistence and replay for capability decisions.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md` and
 * `docs/specs/Concepts/Journal Queue.md`.
 *
 * @since 0.1.0
 */
import * as JournalModule from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type { CapabilityPattern } from "./Capability.ts"
import { decode, type GrantEvent, GrantEventSchema } from "./GrantEvent.ts"
import * as GrantStore from "./GrantStore.ts"
import { GrantStoreError, Rule } from "./Permission.ts"
import { Workspace } from "./Workspace.ts"

/**
 * Configuration for a journal-backed grant store.
 *
 * `policyRunId` is a deliberately dedicated run containing remembered-policy
 * events. The journal has no global grant projection, so callers that want
 * remembered grants to span operational runs must keep this id stable.
 * `planDigest` binds run grants and envelopes to the exact active plan.
 * `sourceId` is also checked during replay; events from other producers cannot
 * activate kernel authority.
 *
 * The journal is authoritative permission storage: SqlJournal must use the
 * `reject` overflow policy. Drop-capable overflow policies are unsupported,
 * because a dropped grant decision cannot safely be treated as persisted.
 *
 * @category models
 * @since 0.1.0
 */
export interface JournalGrantStoreOptions {
  readonly runId: string
  readonly policyRunId: string
  readonly sourceId: string
  readonly planDigest: string
  readonly attended?: boolean
  readonly rules?: ReadonlyArray<ReadonlyArray<Rule>>
  readonly envelope?: {
    readonly patterns: ReadonlyArray<CapabilityPattern>
    readonly scope?: "run" | "remembered" | undefined
  }
}

const journalFailed = (message: string, cause: unknown): GrantStoreError =>
  new GrantStoreError({
    code: "journal_failed",
    message,
    cause
  })

const knownEventTypes: ReadonlySet<string> = new Set([
  "flows.kernel.grant.once.v1",
  "flows.kernel.grant.run.v1",
  "flows.kernel.grant.remembered.v1",
  "flows.kernel.grant.denied.v1",
  "flows.kernel.grant.envelope.v1"
])

const invalidReplay = (message: string): GrantStoreError => new GrantStoreError({ code: "invalid_resolution", message })

const encodeGrantEvent = Schema.encodeSync(GrantEventSchema)

const decodeTrustedEntry = (
  entry: JournalEvent.Entry,
  sourceId: string
): Effect.Effect<GrantEvent | undefined, GrantStoreError> => {
  if (entry.sourceId !== sourceId || !knownEventTypes.has(entry.eventType)) {
    return Effect.succeed(undefined)
  }
  const event = decode(entry.payload)
  if (event._tag === "Failure") {
    return Effect.fail(invalidReplay(`invalid grant payload at journal sequence ${entry.seq}`))
  }
  if (event.success.eventType !== entry.eventType) {
    return Effect.fail(invalidReplay(`grant envelope/payload type mismatch at journal sequence ${entry.seq}`))
  }
  return Effect.succeed(event.success)
}

const envelopeSignature = (
  planDigest: string,
  scope: "run" | "remembered",
  patterns: ReadonlyArray<CapabilityPattern>
): string =>
  JSON.stringify({
    planDigest,
    scope,
    patterns: patterns.map((pattern) => `${pattern.action}:${pattern.resource}`).sort()
  })

const replayRememberedRules = (
  policyRunId: string,
  sourceId: string,
  workspaceRoot: string
) =>
  Effect.gen(function*() {
    const journal = yield* JournalModule.Journal
    const rules: Array<Rule> = []
    const envelopeSignatures = new Set<string>()
    let after: JournalEvent.Seq | undefined

    do {
      const page = yield* journal.entries({
        runId: policyRunId as JournalEvent.RunId,
        ...(after === undefined ? {} : { after }),
        limit: 256
      })
      for (const entry of page.entries) {
        const event = yield* decodeTrustedEntry(entry, sourceId)
        if (event === undefined) {
          continue
        }
        if (event.eventType === "flows.kernel.grant.remembered.v1") {
          if (!GrantStore.isValidGrantPattern(event.pattern, event.capability, event.tier, workspaceRoot)) {
            return yield* Effect.fail(invalidReplay(`unsafe remembered grant event: ${entry.seq}`))
          }
          rules.push(new Rule({ effect: "allow", pattern: event.pattern }))
          continue
        }
        if (event.eventType === "flows.kernel.grant.envelope.v1" && event.scope === "remembered") {
          if (event.patterns.some((pattern) => !GrantStore.isValidEnvelopePattern(pattern, workspaceRoot))) {
            return yield* Effect.fail(invalidReplay(`unsafe remembered envelope event: ${entry.seq}`))
          }
          rules.push(...event.patterns.map((pattern) => new Rule({ effect: "allow" as const, pattern })))
          envelopeSignatures.add(envelopeSignature(event.planDigest, event.scope, event.patterns))
          continue
        }
        return yield* Effect.fail(invalidReplay(`run-scoped event found in policy journal: ${entry.seq}`))
      }
      const last = page.entries.at(-1)
      after = last?.seq
      if (!page.hasMore) {
        return { rules, envelopeSignatures }
      }
    } while (after !== undefined)

    return { rules, envelopeSignatures }
  })

const replayRunRules = (
  runId: string,
  sourceId: string,
  planDigest: string,
  workspaceRoot: string
) =>
  Effect.gen(function*() {
    const journal = yield* JournalModule.Journal
    const rules: Array<Rule> = []
    const envelopeSignatures = new Set<string>()
    let after: JournalEvent.Seq | undefined

    do {
      const page = yield* journal.entries({
        runId: runId as JournalEvent.RunId,
        ...(after === undefined ? {} : { after }),
        limit: 256
      })
      for (const entry of page.entries) {
        const event = yield* decodeTrustedEntry(entry, sourceId)
        if (event === undefined) {
          continue
        }
        if (event.runId !== runId) {
          return yield* Effect.fail(invalidReplay(`grant payload run mismatch at journal sequence ${entry.seq}`))
        }
        if (event.eventType === "flows.kernel.grant.once.v1" || event.eventType === "flows.kernel.grant.denied.v1") {
          continue
        }
        if (event.eventType === "flows.kernel.grant.run.v1") {
          if (event.planDigest !== planDigest) {
            continue
          }
          if (!GrantStore.isValidGrantPattern(event.pattern, event.capability, event.tier, workspaceRoot)) {
            return yield* Effect.fail(invalidReplay(`unsafe run grant event: ${entry.seq}`))
          }
          rules.push(new Rule({ effect: "allow", pattern: event.pattern }))
          continue
        }
        if (event.eventType === "flows.kernel.grant.envelope.v1" && event.scope === "run") {
          if (event.planDigest !== planDigest) {
            continue
          }
          if (event.patterns.some((pattern) => !GrantStore.isValidEnvelopePattern(pattern, workspaceRoot))) {
            return yield* Effect.fail(invalidReplay(`unsafe run envelope event: ${entry.seq}`))
          }
          rules.push(...event.patterns.map((pattern) => new Rule({ effect: "allow" as const, pattern })))
          envelopeSignatures.add(envelopeSignature(event.planDigest, event.scope, event.patterns))
          continue
        }
        return yield* Effect.fail(invalidReplay(`remembered event found in run journal: ${entry.seq}`))
      }
      const last = page.entries.at(-1)
      after = last?.seq
      if (!page.hasMore) {
        return { rules, envelopeSignatures }
      }
    } while (after !== undefined)

    return { rules, envelopeSignatures }
  })

/**
 * Makes a grant store that replays remembered policy from, and writes decisions
 * to, the supplied journal.
 *
 * `emit` admission and `flush` both complete before `GrantStore` activates a
 * remembered or run-scoped rule (or resolves a denial). Any journal failure is
 * mapped to `journal_failed`, so permission decisions fail closed.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: JournalGrantStoreOptions) =>
  Effect.gen(function*() {
    if (options.planDigest.length === 0) {
      return yield* Effect.fail(
        new GrantStoreError({
          code: "invalid_resolution",
          message: "journal-backed grants require a plan digest"
        })
      )
    }
    const journal = yield* JournalModule.Journal
    const workspace = yield* Workspace
    const replayedPolicy = yield* replayRememberedRules(
      options.policyRunId,
      options.sourceId,
      workspace.root
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof GrantStoreError ? cause : journalFailed("could not replay remembered grants", cause)
      )
    )
    const replayedRun = yield* replayRunRules(
      options.runId,
      options.sourceId,
      options.planDigest,
      workspace.root
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof GrantStoreError ? cause : journalFailed("could not replay run grants", cause)
      )
    )
    const persist = (event: GrantEvent): Effect.Effect<void, GrantStoreError> => {
      const payload = encodeGrantEvent(event)
      return Effect.gen(function*() {
        const receipt = yield* journal.emit(
          new JournalEvent.Input({
            runId: (
              event.eventType === "flows.kernel.grant.remembered.v1"
                || (event.eventType === "flows.kernel.grant.envelope.v1" && event.scope === "remembered")
                ? options.policyRunId
                : options.runId
            ) as JournalEvent.RunId,
            sourceId: options.sourceId as JournalEvent.SourceId,
            eventType: event.eventType,
            payload
          })
        )
        if (receipt._tag === "Dropped") {
          return yield* Effect.fail(journalFailed("journal dropped an authoritative grant event", receipt))
        }
        yield* journal.flush
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof GrantStoreError ? cause : journalFailed("could not persist grant event", cause)
        ),
        Effect.asVoid
      )
    }
    const rules = options.rules === undefined || options.rules.length === 0
      ? [[], replayedPolicy.rules]
      : [...options.rules, replayedPolicy.rules]
    const store = yield* GrantStore.make({
      runId: options.runId,
      planDigest: options.planDigest,
      ...(options.attended === undefined ? {} : { attended: options.attended }),
      rules,
      runRules: replayedRun.rules,
      persist
    })
    if (options.envelope === undefined || options.envelope.patterns.length === 0) {
      return store
    }
    const scope = options.envelope.scope ?? "run"
    const signature = envelopeSignature(options.planDigest, scope, options.envelope.patterns)
    const replayedSignatures = scope === "remembered"
      ? replayedPolicy.envelopeSignatures
      : replayedRun.envelopeSignatures
    if (!replayedSignatures.has(signature)) {
      yield* store.grantEnvelope({
        planDigest: options.planDigest,
        patterns: options.envelope.patterns,
        scope
      })
    }
    return store
  })

/**
 * Provides a journal-backed `GrantStore`.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (options: JournalGrantStoreOptions) => Layer.effect(GrantStore.GrantStore)(make(options))
