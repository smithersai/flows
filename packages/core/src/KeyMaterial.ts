/**
 * Digest-free input to `/keys`.
 *
 * Governing contracts:
 * `docs/specs/Concepts/Step Keys.md` and
 * `docs/specs/Concepts/Vendored Flow Engine.md`.
 *
 * Graph-local ids may occur only inside dependency references. The key
 * compiler replaces those references with dependency digests; names and tree
 * positions are never hashed directly.
 *
 * @since 0.0.0
 */

import type * as Effects from "./Effects.ts"
import type * as Placement from "./Placement.ts"

/**
 * A declared input used to identify a planned node.
 *
 * @category models
 * @since 0.0.0
 */
export type InputRef =
  | { readonly _tag: "Literal"; readonly value: unknown }
  | { readonly _tag: "Ref"; readonly from: string; readonly path: ReadonlyArray<string> }
  | { readonly _tag: "Pending"; readonly from: string }

/**
 * Digest-free key material for a planned node.
 *
 * This is the same shape `@smthrs/plan`'s `KeyMaterial` schema decodes, field
 * for field. The two declarations exist because the packages are independent:
 * this one is the type a graph builder produces, the plan one is the schema
 * the key compiler validates. A field added to either must be added to both,
 * or a key loses a dimension on one side of the seam.
 *
 * @category models
 * @since 0.0.0
 */
export interface KeyMaterial {
  readonly version: "flows/key-material/v1"
  readonly kind: "sealed" | "compensable" | "irreversible"
  /**
   * Marks a step whose result is recorded rather than reproduced. The engine
   * stores the first writer's result and every later reader replays it.
   *
   * Absence claims determinism, so only the explicit declaration changes
   * identity and every key already computed for a deterministic step keeps
   * its value.
   */
  readonly nondeterministic?: true | undefined
  readonly body: unknown
  readonly inputs: ReadonlyArray<InputRef>
  readonly layers: ReadonlyArray<string>
  readonly capabilities: ReadonlyArray<string>
  readonly effects: Effects.Declaration | undefined
  readonly placement: Placement.Placement | undefined
}

/**
 * A graph-local association between a node and its digest-free key material.
 *
 * `nodeId` is traversal data and is never part of the material handed to the
 * key compiler.
 *
 * `/keys/StepKey.fromKeyMaterial` consumes these entries and performs
 * dependency-digest substitution before hashing.
 *
 * @category models
 * @since 0.0.0
 */
export interface Entry {
  readonly nodeId: string
  readonly material: KeyMaterial
}
