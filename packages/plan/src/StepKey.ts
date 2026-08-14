/**
 * The KeyMaterial → step-key compiler.
 *
 * Revived from the module deleted at `f5f3dda` (then
 * `packages/keys/src/StepKey.ts`). Two deliberate deviations from the original:
 *
 * 1. **It lives here, not in `@smthrs/keys-next`.** That package was reduced to the
 *    single `Key` transformation on purpose; a compiler that understands plan
 *    material belongs above it.
 * 2. **It produces `@smthrs/keys-next` `Key` values, not a second `sk1_` digest
 *    format.** The original minted its own prefix over a private `Digest`
 *    module. The engine dispatches under `Key` (`FlowEngine/ActionKey.ts`),
 *    so a plan whose node keys were a *different* string format could never be
 *    the thing the cache is consulted against — and that is the whole point of
 *    `docs/specs/Specs/Object Model.md`'s `Plan`. One key format, one hashing
 *    chokepoint (canonical JSON + injected `Crypto`), one namespace field
 *    (`kind`) distinguishing content keys from ordinal ones.
 *
 * Everything the original earned is kept: nominally branded digest inputs (a
 * literal that merely *looks* like `{digest}` hashes as a literal), set
 * normalization, the separate environment namespace, per-variant tagging of
 * resolved references, and the hashed `version`.
 *
 * Governing contract: `docs/specs/Concepts/Step Keys.md`.
 *
 * @since 0.1.0
 */
import { Key } from "@smthrs/keys-next"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type * as KeyMaterial from "./KeyMaterial.ts"

/**
 * A computed step key. Identical in representation to any other flow key —
 * `key1_` plus a SHA-256 digest of the canonical serialization of the material.
 *
 * @since 0.1.0
 * @category models
 */
export type StepKey = Key

/**
 * The nominal brand carried by every {@link DigestInput}. Kept private: the
 * only way to produce a value bearing it is {@link digestInput}, so a plain
 * value that merely happens to look like `{ digest: "..." }` — actions pass
 * content hashes around as ordinary data — can never be mistaken for a genuine
 * upstream-result digest reference. This closes a step-key collision where
 * shape-sniffing (`"digest" in value`) hashed the two identically.
 *
 * @since 0.1.0
 * @category symbols
 */
const DigestInputTypeId: unique symbol = Symbol.for("@smthrs/plan-next/StepKey/DigestInput")

/**
 * A precomputed digest supplied as a step input rather than a literal value.
 *
 * @since 0.1.0
 * @category models
 */
export interface DigestInput {
  readonly [DigestInputTypeId]: typeof DigestInputTypeId
  readonly digest: string
  /**
   * Which kind of graph reference resolved to this digest.
   *
   * `fromKeyMaterial` used to hand-build `{kind: "ref" | "pending" |
   * "ref-projected", ...}` objects that `normalizeInputs` then wrapped a second
   * time as `{kind: "literal", value: <the object just built>}`. Injectivity
   * survived — both sides get the outer wrap — but the module's own
   * `DigestInputTypeId` argument read as if it applied on that path, and it did
   * not. Carrying the discriminator here lets `normalizeInputs` be the single
   * normalizer while keeping the variants mutually distinct.
   */
  readonly reference?: "ref" | "pending" | "ref-projected"
  /** The projection applied to the referenced result, for `ref-projected`. */
  readonly path?: ReadonlyArray<string>
}

/**
 * Nominally tags a precomputed digest so it is hashed as a digest reference
 * rather than a literal value.
 *
 * @since 0.1.0
 * @category constructors
 */
export const digestInput = (
  digest: string,
  reference?: {
    readonly reference: "ref" | "pending" | "ref-projected"
    readonly path?: ReadonlyArray<string>
  }
): DigestInput => ({
  [DigestInputTypeId]: DigestInputTypeId,
  digest,
  ...(reference === undefined ? {} : { reference: reference.reference }),
  ...(reference?.path === undefined ? {} : { path: reference.path })
})

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
 * Three properties matter and none survives a merge:
 *
 * 1. **Non-aliasing.** Concatenating environment material onto the caller's
 *    made `caller{fs:["a"]} + env{fs:["b"]}` hash identically to
 *    `caller{fs:["a","b"]} + env{}` — a cross-run collision in the very
 *    material whose purpose is preventing one.
 * 2. **Declared vs undeclared.** `declared: false` is not the same value as
 *    `declared: true` with empty sets.
 * 3. **Composition order.** Environment layers retain declaration order,
 *    because plugin and service composition order can change behavior. The
 *    caller-owned `ContentIdentity.layers` stays set-normalized.
 *
 * `runScope` is set only when `declared` is `false`: it pins the key to one
 * run, so a step whose environment identity is unknown can never serve a
 * cross-run hit.
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
 * Stable failures while resolving graph-local dependency references.
 *
 * @since 0.1.0
 * @category errors
 */
export class KeyMaterialError extends Schema.TaggedError<KeyMaterialError>()("flows/plan/KeyMaterialError", {
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
        ? {
          kind: "digest",
          digest: value.digest,
          ...(value.reference === undefined ? {} : { reference: value.reference }),
          ...(value.path === undefined ? {} : { path: value.path })
        }
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
      index === 0 || entry.path !== entries[index - 1]!.path || entry.digest !== entries[index - 1]!.digest
    )
  return { readSet, writeSet: sortStrings(hermetic.writeSet), boundaryMode: hermetic.boundaryMode }
}

const decodeKey = Schema.decodeUnknownEffect(Key)

/**
 * Produces a cross-run reusable key for a sealed or hermetic step. Set-like
 * declarations are normalized before serialization; write declarations remain
 * part of the identity even when the step writes nothing.
 *
 * @since 0.1.0
 * @category constructors
 */
export const content = (
  identity: ContentIdentity
): Effect.Effect<StepKey, Schema.SchemaError, Crypto.Crypto> =>
  decodeKey({
    kind: "content",
    body: identity.body,
    inputs: normalizeInputs(identity.inputs),
    layers: sortStrings(identity.layers),
    capabilities: normalizeCapabilities(identity.capabilities),
    ...(identity.environment === undefined ? {} : { environment: normalizeEnvironment(identity.environment) }),
    ...(identity.hermetic === undefined ? {} : { hermetic: normalizeHermetic(identity.hermetic) })
  })

/**
 * Produces a run-local ordinal key for compensable, irreversible, or unsealed
 * work. These keys intentionally cannot be reused across runs.
 *
 * @since 0.1.0
 * @category constructors
 */
export const ordinal = (
  identity: OrdinalIdentity
): Effect.Effect<StepKey, Schema.SchemaError, Crypto.Crypto> => decodeKey({ kind: "ordinal", ...identity })

/**
 * Resolves graph-local references to dependency digests and constructs a
 * content key.
 *
 * This is the handoff the Flow Builder Brief describes: the planner hands over
 * a topologically ordered sequence of `{ nodeId, material }`, and for each one
 * the compiler substitutes every `Ref`/`Pending` with the *already computed
 * key of the referenced node*. Structural node ids are lookup addresses only
 * and never enter the hashed value — rename a node and nothing re-keys; change
 * what a node consumes and everything downstream of it does.
 *
 * @since 0.1.0
 * @category constructors
 */
export const fromKeyMaterial = (
  material: KeyMaterial.KeyMaterial,
  dependencyDigests: Readonly<Record<string, string>>
): Effect.Effect<StepKey, KeyMaterialError | Schema.SchemaError, Crypto.Crypto> => {
  if (material.kind !== "sealed") {
    return Effect.fail(
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
      // Raw, so `normalizeInputs` applies the one literal wrap. Building
      // `{kind: "literal", value}` here got wrapped a second time.
      inputs[String(index)] = input.value
      continue
    }
    const digest = dependencyDigests[input.from]
    if (digest === undefined) {
      return Effect.fail(
        new KeyMaterialError({
          code: "missing_dependency",
          message: `Missing digest for graph dependency ${input.from}`
        })
      )
    }
    inputs[String(index)] = input._tag === "Pending"
      ? digestInput(digest, { reference: "pending" })
      : input.path.length > 0
      ? digestInput(digest, { reference: "ref-projected", path: input.path })
      : digestInput(digest, { reference: "ref" })
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
