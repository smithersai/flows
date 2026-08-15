/**
 * Per-seat visibility for model-invocable flow descriptors.
 *
 * Visibility is a discovery projection. It does not alter the capability
 * envelope or the kernel's authority decision.
 *
 * Governing designs: `docs/specs/Specs/Harness.md` and
 * `docs/specs/Concepts/Injection And Decoration.md`.
 *
 * @since 0.1.0
 */
import type { FlowDescriptor } from "@smthrs/registry/Descriptor"
import * as Schema from "effect/Schema"

/**
 * Whether a matching rule reveals a flow or hides it.
 *
 * @category models
 * @since 0.1.0
 */
export const RuleEffect = Schema.Literals(["allow", "deny"])

/**
 * The decoded form of {@link RuleEffect}.
 *
 * @category models
 * @since 0.1.0
 */
export type RuleEffect = typeof RuleEffect.Type

/** An ordered allow or deny pattern over flow names.
 * @category models
 * @since 0.1.0
 */
export class Rule extends Schema.Class<Rule>("flows/harness/Visibility/Rule")({
  effect: RuleEffect,
  pattern: Schema.String
}) {}

/** An ordered visibility ruleset. The last matching rule wins.
 * @category schemas
 * @since 0.1.0
 */
export const Ruleset = Schema.Array(Rule)

/**
 * The decoded form of {@link Ruleset}.
 *
 * @category models
 * @since 0.1.0
 */
export type Ruleset = typeof Ruleset.Type

/** The resolved visibility policy associated with one model seat.
 * @category models
 * @since 0.1.0
 */
export class Seat extends Schema.Class<Seat>("flows/harness/Visibility/Seat")({
  name: Schema.String,
  ruleset: Ruleset
}) {}

/**
 * The declaration {@link make} takes. `rules` is accepted as an alias for
 * `ruleset`.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions {
  readonly name: string
  readonly ruleset?: Ruleset | undefined
  readonly rules?: Ruleset | undefined
}

/** Constructs a resolved seat visibility policy.
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: MakeOptions): Seat =>
  new Seat({
    name: options.name,
    ruleset: options.ruleset ?? options.rules ?? []
  })

const glob = (pattern: string): RegExp => {
  let expression = "^"
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!
    if (character === "*" && pattern[index + 1] === "*") {
      expression += ".*"
      index++
    } else if (character === "*") {
      expression += ".*"
    } else if (character === "?") {
      expression += "."
    } else {
      expression += /[\\^$+?.()|[\]{}]/.test(character) ? `\\${character}` : character
    }
  }
  return new RegExp(`${expression}$`)
}

const matches = (name: string, pattern: string): boolean => glob(pattern).test(name)

const rulesOf = (seat: Seat | string | Ruleset): Ruleset => {
  if (seat instanceof Seat) return seat.ruleset
  if (Array.isArray(seat)) return seat
  return []
}

const visible = (name: string, ruleset: Ruleset): boolean => {
  let decision: RuleEffect = "deny"
  for (const rule of ruleset) {
    if (matches(name, rule.pattern)) decision = rule.effect
  }
  return decision === "allow"
}

/**
 * Tests whether a model-visible name is admitted by a seat policy.
 *
 * @category predicates
 * @since 0.1.0
 */
export const allows = (name: string, seat: Seat | string | Ruleset): boolean => visible(name, rulesOf(seat))

/**
 * Filters descriptors for a seat using fail-closed, last-match-wins glob
 * rules. A string seat with no resolved policy and an empty ruleset see none.
 *
 * @category filtering
 * @since 0.1.0
 */
export const filter = (
  descriptors: ReadonlyArray<FlowDescriptor>,
  seat: Seat | string | Ruleset
): ReadonlyArray<FlowDescriptor> => {
  return descriptors.filter((descriptor) => allows(descriptor.name, seat))
}
