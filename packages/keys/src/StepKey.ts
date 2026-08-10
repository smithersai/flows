/**
 * Content and ordinal step identities.
 *
 * Governing contract: `docs/specs/Concepts/Step Keys.md`.
 * The graph producer is `packages/core/src/KeyMaterial.ts`.
 *
 * @since 0.1.0
 */
import * as Canonical from "@smthrs/canonical/Canonical"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Digest from "./Digest.ts"
import type { InputRef as CoreInputRef, KeyMaterial as CoreKeyMaterial } from "./KeyMaterial.ts"

/**
 * A stable, versioned step-key digest.
 *
 * @since 0.1.0
 * @category models
 */
export type StepKey = typeof StepKey.Type

/**
 * Schema for a stable, versioned step-key digest.
 *
 * @since 0.1.0
 * @category schemas
 */
export const StepKey = Schema.String.check(Schema.isPattern(/^sk1_[0-9a-f]{64}$/)).pipe(
  Schema.brand("flows/keys/StepKey")
)

/**
 * The nominal brand carried by every `DigestInput`. Kept private: the only way
 * to produce a value bearing it is {@link digestInput}, so a plain literal
 * value that merely happens to look like `{ digest: "..." }` (activities pass
 * content hashes around as ordinary data) can never be mistaken for a genuine
 * upstream-result digest reference. This closes a step-key collision where
 * shape-sniffing (`"digest" in value`) hashed the two identically.
 *
 * @since 0.1.0
 * @category symbols
 */
const DigestInputTypeId: unique symbol = Symbol.for("@smthrs/keys/StepKey/DigestInput")

/**
 * A precomputed digest supplied as a step input rather than a literal value.
 * Constructed only via {@link digestInput} — the brand is what lets
 * `normalizeInputs` tell a real digest reference apart from a literal value
 * that happens to have a `digest` field.
 *
 * @since 0.1.0
 * @category models
 */
export interface DigestInput {
  readonly [DigestInputTypeId]: typeof DigestInputTypeId
  readonly digest: string
}

/**
 * Nominally tags a precomputed digest so it is hashed as a digest reference
 * rather than a literal value. This is the only supported way to produce a
 * `DigestInput` — passing a plain `{ digest: "..." }` object as an input now
 * hashes as a literal, even though its shape matches.
 *
 * @since 0.1.0
 * @category constructors
 */
export const digestInput = (digest: string): DigestInput => ({ [DigestInputTypeId]: DigestInputTypeId, digest })

/**
 * Type guard for values produced by {@link digestInput}.
 *
 * @since 0.1.0
 * @category guards
 */
export const isDigestInput = (value: unknown): value is DigestInput =>
  typeof value === "object" && value !== null && DigestInputTypeId in value &&
  (value as Record<PropertyKey, unknown>)[DigestInputTypeId] === DigestInputTypeId

/**
 * The engine-resolved execution environment a content key is computed under,
 * hashed in its OWN namespace rather than merged into the caller's `layers`
 * and `capabilities`.
 *
 * Two properties matter and neither survives a merge:
 *
 * 1. **Non-aliasing.** Concatenating environment material onto the caller's
 *    made `caller{fs:["a"]} + env{fs:["b"]}` hash identically to
 *    `caller{fs:["a","b"]} + env{}` — a cross-run cache-key collision in the
 *    very material whose purpose is preventing one. A separate namespace
 *    makes the two structurally distinguishable.
 * 2. **Declared vs undeclared.** `declared: false` is not the same value as
 *    `declared: true` with empty sets, so a composition that starts declaring
 *    its environment re-keys instead of inheriting rows recorded while
 *    nothing was declared.
 * 3. **Composition order.** Environment layers retain declaration order
 *    because plugin and service composition order can change behavior. The
 *    caller-owned `ContentIdentity.layers` field remains set-normalized; the
 *    engine-owned namespace is deliberately order-sensitive.
 *
 * `runScope` is set only when `declared` is `false`: it pins the key to one
 * run, so a step whose environment identity is unknown can never serve a
 * cross-run cache hit. Declaring an environment removes it and restores
 * cross-run reuse.
 *
 * @since 0.1.0
 * @category models
 */
export interface EnvironmentIdentity {
  readonly declared: boolean
  readonly layers: ReadonlyArray<string>
  readonly capabilities: Readonly<Record<string, ReadonlyArray<string>>>
  readonly runScope?: string | undefined
}

/**
 * Material describing a sealed or hermetic content-addressed step.
 *
 * Plain input values are literals. Wrap a precomputed digest with
 * {@link digestInput} to hash it as a digest reference; a plain object that
 * merely has a `digest` field (no brand) hashes as a literal.
 *
 * @since 0.1.0
 * @category models
 */
export interface ContentIdentity {
  readonly body: unknown
  readonly inputs: Readonly<Record<string, unknown | DigestInput>>
  readonly layers: ReadonlyArray<string>
  readonly capabilities: Readonly<Record<string, ReadonlyArray<string>>>
  readonly environment?: EnvironmentIdentity | undefined
  readonly hermetic?: {
    readonly readSet: ReadonlyArray<{ readonly path: string; readonly digest: string }>
    readonly writeSet: ReadonlyArray<string>
    readonly boundaryMode: "hard" | "expected"
  } | undefined
}

/**
 * Material describing the run-local identity of a non-cacheable step.
 *
 * @since 0.1.0
 * @category models
 */
export interface OrdinalIdentity {
  readonly runId: string
  readonly parentScope?: string | undefined
  readonly ordinal: number
  readonly tier: "compensable" | "irreversible" | "unsealed"
}

/**
 * A graph-local input reference accepted by the structural planner seam.
 *
 * @since 0.1.0
 * @category models
 */
export type InputRef = CoreInputRef

/**
 * Digest-free planner material produced by `@smthrs/core`.
 *
 * @since 0.1.0
 * @category models
 */
export type KeyMaterial = CoreKeyMaterial

/**
 * Stable failures while resolving graph-local dependency references.
 *
 * @since 0.1.0
 * @category errors
 */
export class KeyMaterialError extends Schema.TaggedErrorClass<KeyMaterialError>()("@smthrs/keys/KeyMaterialError", {
  code: Schema.Literals(["missing_dependency", "non_content_material"]),
  message: Schema.String
}) {}

const sortStrings = (values: ReadonlyArray<string>): Array<string> =>
  [...new Set(values.map((value) => value.normalize("NFC")))].sort()

const normalizeInputs = (inputs: ContentIdentity["inputs"]): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(inputs).map(([name, value]) => [
      name,
      isDigestInput(value)
        ? { kind: "digest", digest: value.digest }
        : { kind: "literal", value }
    ])
  )

const normalizeCapabilities = (capabilities: ContentIdentity["capabilities"]): Record<string, Array<string>> =>
  Object.fromEntries(Object.entries(capabilities).map(([group, patterns]) => [group, sortStrings(patterns)]))

const normalizeEnvironment = (environment: EnvironmentIdentity) => ({
  declared: environment.declared,
  layers: environment.layers.map((layer) => layer.normalize("NFC")),
  capabilities: normalizeCapabilities(environment.capabilities),
  ...(environment.runScope === undefined ? {} : { runScope: environment.runScope })
})

const normalizeHermetic = (hermetic: NonNullable<ContentIdentity["hermetic"]>) => {
  const readSet = [...hermetic.readSet]
    .map((entry) => ({ path: entry.path.normalize("NFC"), digest: entry.digest }))
    .sort((left, right) => {
      if (left.path !== right.path) return left.path < right.path ? -1 : 1
      return left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0
    })
    .filter((entry, index, entries) =>
      index === 0 ||
      entry.path !== entries[index - 1]!.path ||
      entry.digest !== entries[index - 1]!.digest
    )
  return {
    readSet,
    writeSet: sortStrings(hermetic.writeSet),
    boundaryMode: hermetic.boundaryMode
  }
}

const key = (material: unknown): Result.Result<StepKey, Canonical.CanonicalizeError> =>
  Result.map(
    Effect.runSync(Effect.result(Canonical.serialize(material))),
    (serialized) => `sk1_${Digest.digest(serialized)}` as StepKey
  )

/**
 * Produces a cross-run reusable key for a sealed or hermetic step. Set-like
 * declarations are normalized before serialization; write declarations remain
 * part of the identity even when the step writes nothing.
 *
 * @since 0.1.0
 * @category constructors
 */
export const content = (identity: ContentIdentity): Result.Result<StepKey, Canonical.CanonicalizeError> =>
  key({
    kind: "content",
    body: identity.body,
    inputs: normalizeInputs(identity.inputs),
    layers: sortStrings(identity.layers),
    capabilities: normalizeCapabilities(identity.capabilities),
    ...(identity.environment === undefined ? {} : { environment: normalizeEnvironment(identity.environment) }),
    ...(identity.hermetic === undefined ? {} : { hermetic: normalizeHermetic(identity.hermetic) })
  })

/**
 * Resolves graph-local references to dependency digests and constructs a
 * content key. Structural node ids are lookup addresses only and never enter
 * the hashed value.
 *
 * Every `InputRef` variant is tagged with its own `kind` (`"literal"`,
 * `"pending"`, or `"ref"`, further split by whether a `path` projection is
 * present) before hashing, so `Pending{from}` and `Ref{from, path: []}` — both
 * of which resolve to the same dependency digest — no longer collide.
 * `material.version` is folded into the hashed body so a version bump changes
 * every key derived from it, closing a second collision where the declared
 * version field was never actually hashed.
 *
 * @since 0.1.0
 * @category constructors
 */
export const fromKeyMaterial = (
  material: KeyMaterial,
  dependencyDigests: Readonly<Record<string, string>>
): Result.Result<StepKey, KeyMaterialError | Canonical.CanonicalizeError> => {
  if (material.kind !== "sealed") {
    return Result.fail(
      new KeyMaterialError({
        code: "non_content_material",
        message: `Cannot create a content key for ${material.kind} material`
      })
    )
  }
  const inputs: Record<string, unknown> = {}
  for (let index = 0; index < material.inputs.length; index++) {
    const input = material.inputs[index]!
    if (input._tag === "Literal") {
      inputs[String(index)] = { kind: "literal", value: input.value }
      continue
    }
    const digest = dependencyDigests[input.from]
    if (digest === undefined) {
      return Result.fail(
        new KeyMaterialError({
          code: "missing_dependency",
          message: `Missing digest for graph dependency ${input.from}`
        })
      )
    }
    inputs[String(index)] = input._tag === "Pending"
      ? { kind: "pending", digest }
      : input.path.length > 0
      ? { kind: "ref-projected", dependencyDigest: digest, path: input.path }
      : { kind: "ref", digest }
  }
  return content({
    body: {
      version: material.version,
      declaration: material.body,
      ...(material.effects === undefined ? {} : { effects: material.effects }),
      ...(material.placement === undefined ? {} : { placement: material.placement })
    },
    inputs,
    layers: material.layers,
    capabilities: { declared: material.capabilities }
  })
}

/**
 * Produces a run-local ordinal key for compensable, irreversible, or unsealed
 * work. These keys intentionally cannot be reused across runs.
 *
 * @since 0.1.0
 * @category constructors
 */
export const ordinal = (identity: OrdinalIdentity): Result.Result<StepKey, Canonical.CanonicalizeError> =>
  key({ kind: "ordinal", ...identity })
