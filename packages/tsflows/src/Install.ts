/**
 * The `install` flow: measure, fetch, link.
 *
 * `docs/specs/Concepts/Unified Flow Authoring.md` gives two nouns. The atoms
 * here are Actions, because each carries an implementation that is
 * attached separately as a `Layer` and none of them is made of steps. The
 * composite is a Flow, because it has a pure plan-time body and no opaque
 * code of its own.
 *
 * The shape follows Bazel's fetch/build split and rules_js's `npm_translate_lock`
 * split, restated in this vocabulary:
 *
 * | round | step    | tier   | boundary | admitted to the cross-run cache |
 * | ----- | ------- | ------ | -------- | ------------------------------- |
 * | 1     | measure | sealed | expected | no                              |
 * | 2     | fetch/* | sealed | hard     | with sandbox whole-tree proof  |
 * | 2     | link    | sealed | expected | no                              |
 *
 * Every tier is `sealed` because `Plan.compile` refuses to key anything else:
 * `StepKey.fromKeyMaterial` fails with `non_content_material` for
 * `compensable` and `irreversible` declarations, so an `Action` declared at
 * either tier makes the flow unplannable. The `expected` boundary mode is what
 * keeps measure and link out of the cross-run cache, because
 * `ActionPersistence` admits a result only when the tier is `sealed` AND the
 * boundary mode is `hard`. DESIGN.md, section 7, records the gap.
 *
 * A `node_modules` tree is a graph of links into a local store, so
 * restoring one from another machine would produce a tree whose entries point
 * at nothing. Link is therefore never admitted, and measure is not admitted
 * either: it reports the host's package-manager version, which no declared
 * read set covers, so a restored measurement would report the version of
 * whichever machine ran it first.
 *
 * Measure exists as its own step so that planning stays a pure function of
 * declarations, payload, and recorded state (`docs/specs/Concepts/Build
 * Phases.md`). It runs in its own trampoline round because the selected
 * package manager is a run-time Layer value. The next round receives that
 * value as ordinary payload and can therefore select one manager-specific
 * fetch declaration with one exact lockfile boundary. The shipped scheduler
 * already folds settled upstream results into dispatch keys. The trampoline
 * is for static graph selection, not for repairing key derivation.
 *
 * @since 0.1.0
 */
import { Action, Flow } from "@smthrs/flow-next"
import { FileInput } from "@smthrs/flow-next/FileInput"
import * as Node from "@smthrs/plan-next/Node"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as PackageManager from "./PackageManager.ts"

/**
 * Schema for the measured, machine-independent description of an install.
 *
 * Every field is either content (a digest) or identity (a name, a version, a
 * platform). Nothing here is a path into a host's store, because this value
 * travels into a shared cache key.
 *
 * @category models
 * @since 0.1.0
 */
export const Environment = Schema.Struct({
  /** Which manager the layer selected. */
  manager: PackageManager.Name,
  /** The exact version of that manager, measured by running it. */
  managerVersion: Schema.NonEmptyString,
  /** The host facts, present only when this manager's fetch varies by them. */
  platform: Schema.NullOr(PackageManager.Platform),
  /** The lockfile path and its measured digest. */
  lockfile: FileInput,
  /** The credential-free `.npmrc` and its digest, or `null` when absent. */
  npmrc: Schema.NullOr(FileInput)
})

/**
 * The measured, machine-independent description of an install.
 *
 * @category models
 * @since 0.1.0
 */
export type Environment = typeof Environment.Type

/**
 * Schema for what a completed link reports.
 *
 * The digest describes the tree; the tree itself is never a value, never an
 * artifact, and never leaves the host.
 *
 * @category models
 * @since 0.1.0
 */
export const LinkManifest = Schema.Struct({
  /** The store manifest digest this tree was linked from. */
  store: PackageManager.Digest,
  /** Digest of the store, root package manifest, and manager tree evidence. */
  manifest: PackageManager.Digest,
  /** Whether the manager ran, or the tree was already fresh. */
  linked: Schema.Boolean
})

/**
 * What a completed link reports.
 *
 * @category models
 * @since 0.1.0
 */
export type LinkManifest = typeof LinkManifest.Type

/** The lockfiles and configuration the measure action may read. */
const measureInputPatterns: ReadonlyArray<string> = [
  ".npmrc",
  "bun.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock"
]

/**
 * Measures the content every later step keys on.
 *
 * Declared with an `expected` boundary so that no cross-run cache ever answers
 * it. Measure reports the exact version
 * of the package manager installed on this host, and no declared read set
 * covers a binary on `PATH`. A cached measurement would report the version of
 * whichever machine recorded it first, and every downstream key would then
 * claim a manager version that never ran. Re-measuring costs one `--version`
 * spawn and two file digests.
 *
 * @category actions
 * @since 0.1.0
 */
export const Measure = Action.make("tsflows/install/measure", {
  payload: {},
  success: Environment,
  error: PackageManager.PackageManagerError,
  tier: "sealed"
})
  .annotate(Flow.EffectsDeclaration, {
    reads: measureInputPatterns,
    writes: [],
    boundaryMode: "expected"
  })

/**
 * Populates the package-manager store, and writes no `node_modules`.
 *
 * This is the shareable half. Its key material is the measured environment:
 * the lockfile digest, the credential-free `.npmrc` digest, the manager name
 * and its exact version, and the host platform when it affects fetched data.
 * All of it reaches the key as a payload `Literal`, because the
 * measurement arrived as this round's payload rather than as an upstream
 * reference. Its value is a store-manifest digest, never the store's bytes and
 * never a `node_modules` archive. The store files are declared outputs. The
 * existing artifact CAS records and hydrates them before replaying a hit.
 *
 * Every manager uses a workspace-local directory beneath `.flows/store`.
 * This static path lets the sandbox boundary prove the complete write set and
 * publish the files without publishing `node_modules`.
 *
 * @category actions
 * @since 0.1.0
 */
const makeFetch = <Tag extends string>(
  name: Tag,
  lockfile: string,
  manager: PackageManager.Name
) =>
  Action.make(name, {
    payload: {
      environment: Environment
    },
    success: PackageManager.StoreManifest,
    error: PackageManager.PackageManagerError,
    tier: "sealed"
  })
    .annotate(Flow.EffectsDeclaration, {
      reads: [lockfile, ".npmrc"],
      writes: [{ _tag: "TreeArtifact", path: `${PackageManager.storeRoot}/${manager}` }],
      boundaryMode: "hard"
    })

/**
 * Fetches npm packages from `package-lock.json`.
 *
 * @category actions
 * @since 0.1.0
 */
export const FetchNpm = makeFetch("tsflows/install/fetch/npm", "package-lock.json", "npm")

/**
 * Fetches pnpm packages from `pnpm-lock.yaml`.
 *
 * @category actions
 * @since 0.1.0
 */
export const FetchPnpm = makeFetch("tsflows/install/fetch/pnpm", "pnpm-lock.yaml", "pnpm")

/**
 * Fetches Bun packages from `bun.lock`.
 *
 * @category actions
 * @since 0.1.0
 */
export const FetchBun = makeFetch("tsflows/install/fetch/bun", "bun.lock", "bun")

/**
 * Declares the future Yarn fetch boundary.
 *
 * The current Yarn layer fails with `unsupported` before it writes.
 *
 * @category actions
 * @since 0.1.0
 */
export const FetchYarn = makeFetch("tsflows/install/fetch/yarn", "yarn.lock", "yarn")

/**
 * Materializes `node_modules` from the already-populated store.
 *
 * Its `expected` boundary is what keeps it out of the cross-run cache;
 * `compensable` would say the same thing about retry semantics but would make
 * the flow unplannable, so the tier stays `sealed`. See the module doc. Its
 * step key still supports local freshness checks: an unchanged key lets the
 * same run, or the next run on this machine, skip the work.
 * Its write set is empty on purpose. The current boundary contract turns
 * declared writes into materialized artifacts, so naming `node_modules` would
 * violate the rule that this tree is never cached. An isolated sandbox may
 * observe the write as an expected-set deviation without failing the action.
 *
 * @category actions
 * @since 0.1.0
 */
export const Link = Action.make("tsflows/install/link", {
  payload: {
    environment: Environment,
    store: PackageManager.StoreManifest
  },
  success: LinkManifest,
  error: PackageManager.PackageManagerError,
  tier: "sealed"
})
  .annotate(Flow.EffectsDeclaration, {
    reads: ["package.json"],
    // A declared output is also materialized evidence in the current engine.
    // Naming node_modules here would cache the tree as file artifacts. The
    // expected boundary instead records sandbox-observed writes as a deviation.
    writes: [],
    boundaryMode: "expected"
  })

/**
 * The install payload.
 *
 * `environment` is absent on the first round and present on the second. The
 * project root is the engine's working directory, so it does not enter a
 * content key.
 *
 * @category models
 * @since 0.1.0
 */
export const payloadFields = {
  environment: Schema.optional(Environment)
}

/**
 * The implementations the body names.
 *
 * The two rounds name disjoint sets, so the body's return type is annotated
 * with their union: inference over a conditional would otherwise collapse to
 * whichever branch it read first.
 *
 * @category models
 * @since 0.1.0
 */
export type Requires =
  | Action.Requirement<"tsflows/install/measure">
  | Action.Requirement<"tsflows/install/fetch/npm">
  | Action.Requirement<"tsflows/install/fetch/pnpm">
  | Action.Requirement<"tsflows/install/fetch/bun">
  | Action.Requirement<"tsflows/install/fetch/yarn">
  | Action.Requirement<"tsflows/install/link">

/**
 * The declaration shape the recursive body names itself under.
 *
 * The annotation is required rather than stylistic: a body that hands off to
 * its own flow refers to the binding it is initializing, and only an explicit
 * type breaks that cycle. `to` drops requirements, so the union stays finite.
 *
 * @category models
 * @since 0.1.0
 */
export type InstallFlow = Flow.Flow<
  "tsflows/install",
  Schema.Struct<typeof payloadFields>,
  typeof LinkManifest,
  typeof PackageManager.PackageManagerError,
  Requires
>

/**
 * Installs a project's dependencies.
 *
 * The body is pure: it records nodes and executes nothing. It runs in two
 * rounds because the manager selected by a Layer is unknown during round-one
 * planning. Round one measures and hands off with `to`. Round two receives an
 * ordinary environment value, selects exactly one manager-specific fetch
 * declaration, and hashes the manager name, exact version, platform, and file
 * digests inline. Round two never hands off again, so the lineage is two
 * rounds and `maxRounds` says so.
 *
 * The capability ceiling is declared here rather than per action because
 * `Graph.build` reads it from the flow and copies it onto every node it
 * records; an `Action` declaration's own `Flow.Capabilities` annotation is
 * never read. DESIGN.md records that discrepancy against
 * `docs/specs/Concepts/Step Keys.md`, which describes capabilities as
 * per-step key material.
 *
 * @category flows
 * @since 0.1.0
 */
export const Install: InstallFlow = Flow.make("tsflows/install", {
  payload: payloadFields,
  success: LinkManifest,
  error: PackageManager.PackageManagerError,
  maxRounds: 2,
  body: ({ environment }): Node.Node<
    Flow.BodySuccess<typeof LinkManifest.Type>,
    PackageManager.PackageManagerError,
    Requires
  > =>
    environment === undefined
      ? Measure.call({}).pipe(
        Node.andThen((measured) => Install.to({ environment: measured }))
      )
      : environment.manager === "npm"
      ? FetchNpm.call({ environment }).pipe(Node.andThen((store) => Link.call({ environment, store })))
      : environment.manager === "pnpm"
      ? FetchPnpm.call({ environment }).pipe(Node.andThen((store) => Link.call({ environment, store })))
      : environment.manager === "bun"
      ? FetchBun.call({ environment }).pipe(Node.andThen((store) => Link.call({ environment, store })))
      : FetchYarn.call({ environment }).pipe(Node.andThen((store) => Link.call({ environment, store })))
}).annotate(Flow.Capabilities, ["fs:read", "fs:write", "net:get", "net:post", "proc:spawn"])

/** @private */
const environmentMismatch = (message: string): PackageManager.PackageManagerError =>
  new PackageManager.PackageManagerError({ code: "environment_mismatch", message })

/**
 * Rechecks round-one measurements before a durable round-two fetch.
 *
 * @private
 */
const verifyEnvironment = (
  manager: PackageManager.Service,
  expected: Environment
): Effect.Effect<
  void,
  PackageManager.PackageManagerError,
  FileSystem.FileSystem | Crypto.Crypto
> =>
  Effect.gen(function*() {
    const managerVersion = yield* manager.version
    const lockfile = yield* PackageManager.lockfileDigest(manager.projectRoot, manager.lockfileName)
    const npmrc = yield* PackageManager.npmrcDigest(manager.projectRoot)
    const platform = manager.platformSensitive ? manager.platform : null
    const samePlatform = expected.platform === null
      ? platform === null
      : platform !== null &&
        expected.platform.os === platform.os &&
        expected.platform.arch === platform.arch &&
        expected.platform.libc === platform.libc
    if (
      expected.manager !== manager.name ||
      expected.managerVersion !== managerVersion ||
      expected.lockfile.path !== manager.lockfileName ||
      expected.lockfile.digest !== lockfile ||
      (expected.npmrc === null
        ? npmrc !== null
        : expected.npmrc.path !== ".npmrc" || expected.npmrc.digest !== npmrc) ||
      !samePlatform
    ) {
      return yield* Effect.fail(environmentMismatch("the measured install environment changed after measurement"))
    }
  })

/**
 * Refuses to link a store with a different manager implementation.
 *
 * @private
 */
const verifyStoreManager = (
  expected: Environment,
  store: PackageManager.StoreManifest
): Effect.Effect<void, PackageManager.PackageManagerError> => {
  const samePlatform = store.platform === null
    ? expected.platform === null
    : expected.platform !== null &&
      store.platform.os === expected.platform.os &&
      store.platform.arch === expected.platform.arch &&
      store.platform.libc === expected.platform.libc
  return store.manager === expected.manager &&
      store.managerVersion === expected.managerVersion &&
      samePlatform
    ? Effect.void
    : Effect.fail(environmentMismatch("the fetched store does not match the measured environment"))
}

/**
 * The implementation of {@link Measure}.
 *
 * @category layers
 * @since 0.1.0
 */
export const MeasureLive = Measure.toLayer(() =>
  Effect.gen(function*() {
    const manager = yield* PackageManager.PackageManager
    const managerVersion = yield* manager.version
    const lockfile = yield* PackageManager.lockfileDigest(manager.projectRoot, manager.lockfileName)
    const npmrc = yield* PackageManager.npmrcDigest(manager.projectRoot)
    return {
      manager: manager.name,
      managerVersion,
      platform: manager.platformSensitive ? manager.platform : null,
      lockfile: { path: manager.lockfileName, digest: lockfile },
      npmrc: npmrc === null ? null : { path: ".npmrc", digest: npmrc }
    }
  })
)

/**
 * The implementation shared by the manager-specific fetch declarations.
 *
 * @private
 * @since 0.1.0
 */
export const executeFetch = ({ environment }: { readonly environment: Environment }) =>
  Effect.gen(function*() {
    const manager = yield* PackageManager.PackageManager
    yield* verifyEnvironment(manager, environment)
    yield* manager.fetch
    return yield* PackageManager.storeManifest({
      manager: environment.manager,
      managerVersion: environment.managerVersion,
      platform: environment.platform,
      lockfileDigest: environment.lockfile.digest,
      npmrcDigest: environment.npmrc === null ? null : environment.npmrc.digest
    })
  })

/**
 * Implements {@link FetchNpm}.
 *
 * @category layers
 * @since 0.1.0
 */
export const FetchNpmLive = FetchNpm.toLayer(executeFetch)

/**
 * Implements {@link FetchPnpm}.
 *
 * @category layers
 * @since 0.1.0
 */
export const FetchPnpmLive = FetchPnpm.toLayer(executeFetch)

/**
 * Implements {@link FetchBun}.
 *
 * @category layers
 * @since 0.1.0
 */
export const FetchBunLive = FetchBun.toLayer(executeFetch)

/**
 * Implements {@link FetchYarn} through the selected manager layer.
 *
 * @category layers
 * @since 0.1.0
 */
export const FetchYarnLive = FetchYarn.toLayer(executeFetch)

/**
 * The implementation of {@link Link}.
 *
 * Link always asks the selected package manager to reconcile `node_modules`.
 * Manager metadata such as npm's hidden lockfile or pnpm's modules manifest
 * describes the intended graph, but cannot prove that every package file is
 * still present and unmodified. Treating that metadata as a freshness proof
 * would silently accept a deleted or corrupted package. The expected boundary
 * keeps this work local and out of the shared action cache.
 *
 * @category layers
 * @since 0.1.0
 */
export const executeLink = ({ environment, store }: {
  readonly environment: Environment
  readonly store: PackageManager.StoreManifest
}) =>
  Effect.gen(function*() {
    const manager = yield* PackageManager.PackageManager
    yield* verifyEnvironment(manager, environment)
    yield* verifyStoreManager(environment, store)
    const packageJsonDigest = yield* PackageManager.packageJsonDigest(manager.projectRoot)
    yield* manager.link
    const managerEvidence = yield* manager.linkManifest
    const manifest = yield* PackageManager.linkedTreeManifest({
      storeDigest: store.digest,
      packageJsonDigest,
      managerEvidence
    })
    return { store: store.digest, manifest, linked: true }
  })

/**
 * Live implementation of the package-manager link action.
 *
 * @category layers
 * @since 0.1.0
 */
export const LinkLive = Link.toLayer(executeLink)

/**
 * Every implementation the {@link Install} flow needs.
 *
 * Compose it over a `PackageManager` layer, a `FlowRuntime`, and the host
 * services those need. Selecting the manager is the only choice a consumer
 * makes.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = Layer.mergeAll(
  MeasureLive,
  FetchNpmLive,
  FetchPnpmLive,
  FetchBunLive,
  FetchYarnLive,
  LinkLive
)
