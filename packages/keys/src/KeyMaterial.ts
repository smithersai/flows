/**
 * The key-material contract, owned here in `@flows/keys` — the lowest package
 * in the keying seam. `@flows/core` produces values matching this shape (its
 * richer `KeyMaterial` with concrete `Effects`/`Placement` is structurally
 * assignable, since this module treats those fields opaquely for hashing).
 * Keys stays pure: it never imports `@flows/*` (enforced by Purity.test.ts).
 *
 * @since 0.1.0
 */

/**
 * A reference to one declared input of a step: a value hashed inline, or a
 * digest of an upstream step's recorded result.
 *
 * @since 0.1.0
 * @category models
 */
export type InputRef =
  | { readonly _tag: "Literal"; readonly value: unknown }
  | { readonly _tag: "Ref"; readonly from: string; readonly path: ReadonlyArray<string> }
  | { readonly _tag: "Pending"; readonly from: string }

/**
 * Everything that can change a step's result, handed to the digest. `effects`
 * and `placement` are opaque here — canonically serialized, never interpreted
 * — which is what keeps this package free of `@flows/core` types.
 *
 * @since 0.1.0
 * @category models
 */
export interface KeyMaterial {
  readonly version: "flows/key-material/v1"
  readonly kind: "sealed" | "compensable" | "irreversible"
  readonly body: unknown
  readonly inputs: ReadonlyArray<InputRef>
  readonly layers: ReadonlyArray<string>
  readonly capabilities: ReadonlyArray<string>
  readonly effects: unknown
  readonly placement: unknown
}
