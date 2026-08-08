/**
 * Monotone capability authority represented as exact intersections of
 * wildcard languages.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md`,
 * `docs/specs/Concepts/Step Keys.md`, and `docs/specs/Specs/Plan.md`.
 *
 * @since 0.1.0
 */
import { Context, Effect } from "effect"
import { type Capability, type CapabilityPattern, matches, subsumes } from "./Capability.ts"

const CapabilitySetTypeId: unique symbol = Symbol.for("@smithers/kernel/CapabilitySet")

/**
 * A normalized conjunction of any-of capability-pattern groups.
 *
 * An empty outer array is unrestricted authority. An empty inner group denies
 * every capability.
 *
 * @category models
 * @since 0.1.0
 */
export interface CapabilitySet {
  readonly [CapabilitySetTypeId]: typeof CapabilitySetTypeId
  readonly groups: ReadonlyArray<ReadonlyArray<CapabilityPattern>>
}

const comparePattern = (left: CapabilityPattern, right: CapabilityPattern): number =>
  left.action < right.action ?
    -1 :
    left.action > right.action ?
    1 :
    left.resource < right.resource ?
    -1 :
    left.resource > right.resource ?
    1 :
    0

const compareGroup = (
  left: ReadonlyArray<CapabilityPattern>,
  right: ReadonlyArray<CapabilityPattern>
): number => {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const order = comparePattern(left[index]!, right[index]!)
    if (order !== 0) {
      return order
    }
  }
  return left.length - right.length
}

const normalizeGroup = (
  patterns: ReadonlyArray<CapabilityPattern>
): ReadonlyArray<CapabilityPattern> => {
  const sorted = patterns.slice().sort(comparePattern)
  const normalized: Array<CapabilityPattern> = []
  for (const pattern of sorted) {
    const previous = normalized.at(-1)
    if (previous === undefined || comparePattern(previous, pattern) !== 0) {
      normalized.push(pattern)
    }
  }
  return Object.freeze(normalized)
}

const fromNormalizedGroups = (
  groups: ReadonlyArray<ReadonlyArray<CapabilityPattern>>
): CapabilitySet => {
  const set: CapabilitySet = {
    [CapabilitySetTypeId]: CapabilitySetTypeId,
    groups: Object.freeze(groups)
  }
  return Object.freeze(set)
}

const make = (
  groups: ReadonlyArray<ReadonlyArray<CapabilityPattern>>
): CapabilitySet => {
  const sorted = groups.map(normalizeGroup).sort(compareGroup)
  if (sorted.some((group) => group.length === 0)) {
    return fromNormalizedGroups([Object.freeze([])])
  }

  const normalized: Array<ReadonlyArray<CapabilityPattern>> = []
  for (const group of sorted) {
    const previous = normalized.at(-1)
    if (previous === undefined || compareGroup(previous, group) !== 0) {
      normalized.push(group)
    }
  }
  return fromNormalizedGroups(normalized)
}

/**
 * Creates authority described by one any-of group.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromPatterns = (
  patterns: ReadonlyArray<CapabilityPattern>
): CapabilitySet => make([patterns])

const unrestricted: CapabilitySet = make([])

/**
 * Empty authority. Its single empty any-of group rejects every capability.
 *
 * @category defaults
 * @since 0.1.0
 */
export const none: CapabilitySet = make([[]])

/**
 * Tests whether every group contains a pattern matching the capability.
 *
 * @category predicates
 * @since 0.1.0
 */
export const allows = (
  set: CapabilitySet,
  capability: Capability
): boolean => set.groups.every((group) => group.some((pattern) => matches(pattern, capability)))

/**
 * Tests whether the set provably contains every capability selected by one
 * declared requirement pattern.
 *
 * @category predicates
 * @since 0.1.0
 */
export const allowsPattern = (
  set: CapabilitySet,
  required: CapabilityPattern
): boolean => set.groups.every((group) => group.some((pattern) => subsumes(pattern, required)))

/**
 * Intersects two authorities without synthesizing or simplifying globs.
 *
 * @category combinators
 * @since 0.1.0
 */
export const intersect = (
  left: CapabilitySet,
  right: CapabilitySet
): CapabilitySet => make([...left.groups, ...right.groups])

/**
 * Tests structural equality between normalized capability sets.
 *
 * @category equivalence
 * @since 0.1.0
 */
export const equals = (
  left: CapabilitySet,
  right: CapabilitySet
): boolean => {
  if (left.groups.length !== right.groups.length) {
    return false
  }
  for (let index = 0; index < left.groups.length; index += 1) {
    if (compareGroup(left.groups[index]!, right.groups[index]!) !== 0) {
      return false
    }
  }
  return true
}

const CurrentCapabilities: Context.Reference<CapabilitySet> = Context.Reference<CapabilitySet>(
  "@smithers/kernel/CurrentCapabilities",
  { defaultValue: () => unrestricted }
)

/**
 * Reads the current fiber's capability authority.
 *
 * The underlying service reference is deliberately private. Callers can
 * inspect authority and attenuate it, but cannot replace the ambient service
 * with a wider set.
 *
 * @category accessors
 * @since 0.1.0
 */
export const current: Effect.Effect<CapabilitySet> = CurrentCapabilities

/**
 * Runs an effect with authority intersected with one additional any-of group.
 *
 * @category combinators
 * @since 0.1.0
 */
export const attenuate = (
  patterns: ReadonlyArray<CapabilityPattern>
): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> =>
<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.updateService(
    effect,
    CurrentCapabilities,
    (parent) => intersect(parent, fromPatterns(patterns))
  )
