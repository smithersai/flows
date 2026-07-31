/**
 * Hermetic step boundary contracts and the deterministic test implementation.
 *
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

/** @since 0.1.0 @category models */
export const BoundaryMode = Schema.Literals(["hard", "expected"])

/** @since 0.1.0 @category models */
export type BoundaryMode = typeof BoundaryMode.Type

/** @since 0.1.0 @category models */
export const ReadSetEntry = Schema.Struct({
  path: Schema.String,
  digest: Schema.String
})

/** @since 0.1.0 @category models */
export type ReadSetEntry = typeof ReadSetEntry.Type

/** @since 0.1.0 @category models */
export const Descriptor = Schema.Struct({
  readSet: Schema.Array(ReadSetEntry),
  writeSet: Schema.Array(Schema.String),
  boundaryMode: BoundaryMode
})

/** @since 0.1.0 @category models */
export type Descriptor = typeof Descriptor.Type

/** @since 0.1.0 @category models */
export interface PreparedBoundary {
  readonly descriptor: Descriptor
  readonly readSnapshot: ReadonlyArray<ReadSetEntry>
}

/** @since 0.1.0 @category models */
export const BoundaryDeviation = Schema.TaggedStruct("ExpectedSetDeviation", {
  paths: Schema.Array(Schema.String),
  diffIdentity: Schema.NonEmptyString
})

/** @since 0.1.0 @category models */
export type BoundaryDeviation = typeof BoundaryDeviation.Type

/** @since 0.1.0 @category models */
export const BoundaryEvidence = Schema.Struct({
  declaredOutputs: Schema.Unknown,
  diffIdentity: Schema.NonEmptyString,
  deviation: Schema.optional(BoundaryDeviation)
})

/** @since 0.1.0 @category models */
export type BoundaryEvidence = typeof BoundaryEvidence.Type

/** @since 0.1.0 @category errors */
export class UndeclaredWrite extends Schema.TaggedErrorClass<UndeclaredWrite>()(
  "flows/engine-store/UndeclaredWrite",
  {
    code: Schema.Literal("undeclared_write"),
    paths: Schema.Array(Schema.String),
    diffIdentity: Schema.NonEmptyString
  }
) {}

/** @since 0.1.0 @category errors */
export class UnsupportedBoundary extends Schema.TaggedErrorClass<UnsupportedBoundary>()(
  "flows/engine-store/UnsupportedBoundary",
  {
    code: Schema.Literal("unsupported_boundary"),
    message: Schema.String
  }
) {}

/** @since 0.1.0 @category models */
export interface Service {
  readonly prepare: (descriptor: Descriptor) => Effect.Effect<PreparedBoundary, UnsupportedBoundary>
  readonly settle: (
    prepared: PreparedBoundary
  ) => Effect.Effect<BoundaryEvidence, UndeclaredWrite | UnsupportedBoundary>
  readonly replayOutputs: (evidence: BoundaryEvidence) => Effect.Effect<void, UnsupportedBoundary>
}

/** @since 0.1.0 @category services */
export const StepBoundary: Context.Service<Service, Service> = Context.Service<Service>(
  "flows/engine-store/StepBoundary"
)

/** @since 0.1.0 @category constructors */
export const make = (service: Service): Service => StepBoundary.of(service)

/** @since 0.1.0 @category models */
export interface TestOptions {
  readonly changedPaths?: ReadonlyArray<string> | undefined
  readonly declaredOutputs?: unknown
  readonly diffIdentity?: string | undefined
  readonly supported?: boolean | undefined
  readonly onReplay?: (evidence: BoundaryEvidence) => void
}

const unsupported = (): UnsupportedBoundary =>
  new UnsupportedBoundary({
    code: "unsupported_boundary",
    message: "the host cannot enforce the declared step boundary"
  })

/**
 * Deterministic in-memory boundary suitable only for tests.
 *
 * TODO(piece-6): fold into @smithers/journal — needs just-bash VFS seeding,
 * sandbox bind mounts, structured changed-path reporting, and output
 * materialization in host/kernel public contracts.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerTest = (options: TestOptions = {}): Layer.Layer<Service> => {
  const changedPaths = options.changedPaths ?? []
  const diffIdentity = options.diffIdentity ?? "test-diff"
  const service = make({
    prepare: Effect.fn("StepBoundary.prepare")(function*(descriptor) {
      if (options.supported === false) return yield* Effect.fail(unsupported())
      return { descriptor, readSnapshot: descriptor.readSet }
    }),
    settle: Effect.fn("StepBoundary.settle")(function*(prepared) {
      if (options.supported === false) return yield* Effect.fail(unsupported())
      const undeclared = changedPaths.filter((path) => !prepared.descriptor.writeSet.includes(path))
      if (undeclared.length > 0 && prepared.descriptor.boundaryMode === "hard") {
        return yield* Effect.fail(new UndeclaredWrite({ code: "undeclared_write", paths: undeclared, diffIdentity }))
      }
      return {
        declaredOutputs: options.declaredOutputs ?? { paths: prepared.descriptor.writeSet },
        diffIdentity,
        ...(undeclared.length === 0
          ? {}
          : { deviation: { _tag: "ExpectedSetDeviation" as const, paths: undeclared, diffIdentity } })
      }
    }),
    replayOutputs: Effect.fn("StepBoundary.replayOutputs")(function*(evidence) {
      if (options.supported === false) return yield* Effect.fail(unsupported())
      yield* Effect.sync(() => {
        options.onReplay?.(evidence)
      })
    })
  })
  return Layer.succeed(StepBoundary, service)
}
