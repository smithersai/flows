/**
 * Content and ordinal step identities.
 *
 * Governing contract: `docs/specs/Concepts/Step Keys.md`.
 * The graph producer is `packages/core/src/KeyMaterial.ts`.
 *
 * @since 0.1.0
 */
import type {
  InputRef as CoreInputRef,
  KeyMaterial as CoreKeyMaterial
} from "./KeyMaterial.ts"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Canonical from "./Canonical.ts"
import * as Digest from "./Digest.ts"

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
 * A precomputed digest supplied as a step input rather than a literal value.
 *
 * @since 0.1.0
 * @category models
 */
export interface DigestInput {
  readonly digest: string
}

/**
 * Material describing a sealed or hermetic content-addressed step.
 *
 * Plain input values are literals. Wrap a precomputed digest in `{ digest }`;
 * it is explicitly tagged before canonicalization.
 *
 * @since 0.1.0
 * @category models
 */
export interface ContentIdentity {
  readonly body: unknown
  readonly inputs: Readonly<Record<string, unknown | DigestInput>>
  readonly layers: ReadonlyArray<string>
  readonly capabilities: Readonly<Record<string, ReadonlyArray<string>>>
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
 * Digest-free planner material produced by `@flows/core`.
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
export class KeyMaterialError extends Schema.TaggedErrorClass<KeyMaterialError>()("@flows/keys/KeyMaterialError", {
  code: Schema.Literals(["missing_dependency", "non_content_material"]),
  message: Schema.String
}) {}

const sortStrings = (values: ReadonlyArray<string>): Array<string> =>
  [...new Set(values.map((value) => value.normalize("NFC")))].sort()

const normalizeInputs = (inputs: ContentIdentity["inputs"]): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(inputs).map(([name, value]) => [
      name,
      typeof value === "object" && value !== null && Object.keys(value).length === 1 && "digest" in value &&
        typeof value.digest === "string"
        ? { kind: "digest", digest: value.digest }
        : { kind: "literal", value }
    ])
  )

const normalizeCapabilities = (capabilities: ContentIdentity["capabilities"]): Record<string, Array<string>> =>
  Object.fromEntries(Object.entries(capabilities).map(([group, patterns]) => [group, sortStrings(patterns)]))

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

const key = (material: unknown): Result.Result<StepKey, Canonical.CanonicalError> =>
  Result.map(Canonical.serialize(material), (serialized) => `sk1_${Digest.digest(serialized)}` as StepKey)

/**
 * Produces a cross-run reusable key for a sealed or hermetic step. Set-like
 * declarations are normalized before serialization; write declarations remain
 * part of the identity even when the step writes nothing.
 *
 * @since 0.1.0
 * @category constructors
 */
export const content = (identity: ContentIdentity): Result.Result<StepKey, Canonical.CanonicalError> =>
  key({
    kind: "content",
    body: identity.body,
    inputs: normalizeInputs(identity.inputs),
    layers: sortStrings(identity.layers),
    capabilities: normalizeCapabilities(identity.capabilities),
    ...(identity.hermetic === undefined ? {} : { hermetic: normalizeHermetic(identity.hermetic) })
  })

/**
 * Resolves graph-local references to dependency digests and constructs a
 * content key. Structural node ids are lookup addresses only and never enter
 * the hashed value.
 *
 * @since 0.1.0
 * @category constructors
 */
export const fromKeyMaterial = (
  material: KeyMaterial,
  dependencyDigests: Readonly<Record<string, string>>
): Result.Result<StepKey, KeyMaterialError | Canonical.CanonicalError> => {
  if (material.kind !== "sealed") {
    return Result.fail(new KeyMaterialError({
      code: "non_content_material",
      message: `Cannot create a content key for ${material.kind} material`
    }))
  }
  const inputs: Record<string, unknown | DigestInput> = {}
  for (let index = 0; index < material.inputs.length; index++) {
    const input = material.inputs[index]!
    if (input._tag === "Literal") {
      inputs[String(index)] = input.value
      continue
    }
    const digest = dependencyDigests[input.from]
    if (digest === undefined) {
      return Result.fail(new KeyMaterialError({
        code: "missing_dependency",
        message: `Missing digest for graph dependency ${input.from}`
      }))
    }
    inputs[String(index)] = input._tag === "Ref" && input.path.length > 0
      ? { dependencyDigest: digest, path: input.path }
      : { digest }
  }
  return content({
    body: {
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
export const ordinal = (identity: OrdinalIdentity): Result.Result<StepKey, Canonical.CanonicalError> =>
  key({ kind: "ordinal", ...identity })
