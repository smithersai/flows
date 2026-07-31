/**
 * Typed permission failures and capability policy rules.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md` and
 * `docs/specs/Concepts/Trust Granularity.md`.
 *
 * @since 0.1.0
 */
import { Schema } from "effect"
import { Capability, CapabilityPattern, type EffectTier, matches } from "./Capability.ts"

/**
 * A permission request that must be resolved by an attended surface.
 *
 * The capability is always the exact adapter request, never a wildcard.
 *
 * @category errors
 * @since 0.1.0
 */
export class PermissionRequired extends Schema.TaggedErrorClass<PermissionRequired>()(
  "@smithers/kernel/PermissionRequired",
  {
    code: Schema.Literal("permission_required"),
    requestId: Schema.String,
    runId: Schema.optional(Schema.String),
    capability: Capability,
    tier: Schema.Literals(["sealed", "compensable", "irreversible"]),
    meta: Schema.Record(Schema.String, Schema.Unknown)
  }
) {
  constructor(props: {
    readonly code?: "permission_required"
    readonly requestId: string
    readonly runId?: string | undefined
    readonly capability: Capability
    readonly tier: EffectTier
    readonly meta: Record<string, unknown>
  }) {
    super({ ...props, code: "permission_required" })
  }
}

/**
 * A capability rejected by policy or by the current capability ceiling.
 *
 * @category errors
 * @since 0.1.0
 */
export class PermissionDenied extends Schema.TaggedErrorClass<PermissionDenied>()(
  "@smithers/kernel/PermissionDenied",
  {
    code: Schema.Literal("permission_denied"),
    capability: Capability,
    reason: Schema.String
  }
) {
  constructor(props: {
    readonly code?: "permission_denied"
    readonly capability: Capability
    readonly reason: string
  }) {
    super({ ...props, code: "permission_denied" })
  }
}

/**
 * Stable grant-store failure codes.
 *
 * @category models
 * @since 0.1.0
 */
export const GrantStoreErrorCode = Schema.Literals([
  "duplicate_request",
  "request_not_found",
  "journal_failed",
  "store_closed",
  "invalid_resolution"
])

/**
 * Stable grant-store failure codes.
 *
 * @category models
 * @since 0.1.0
 */
export type GrantStoreErrorCode = typeof GrantStoreErrorCode.Type

/**
 * A failure to register, persist, or resolve a grant request.
 *
 * `message` and `cause` are optional operation context for persistence
 * adapters; callers branch on the stable `code`.
 *
 * @category errors
 * @since 0.1.0
 */
export class GrantStoreError extends Schema.TaggedErrorClass<GrantStoreError>()(
  "@smithers/kernel/GrantStoreError",
  {
    code: GrantStoreErrorCode,
    message: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect())
  }
) {}

/**
 * The decision made by a matching permission rule.
 *
 * @category models
 * @since 0.1.0
 */
export type RuleEffect = "allow" | "deny" | "ask"

const RuleEffect = Schema.Literals(["allow", "deny", "ask"])

/**
 * A capability pattern and the decision it applies.
 *
 * @category models
 * @since 0.1.0
 */
export class Rule extends Schema.Class<Rule>("@smithers/kernel/Permission/Rule")({
  effect: RuleEffect,
  pattern: CapabilityPattern
}) {}

/**
 * Evaluates ordered permission rules.
 *
 * Matching rules are last-match-wins across all rulesets and the default is
 * `ask`. The configured ruleset is first reduced with that same rule before
 * an effective configured denial is treated as a hard veto. A configured deny
 * superseded by a later configured allow or ask is therefore not a veto.
 *
 * @category policy
 * @since 0.1.0
 */
export const evaluate = (
  rulesets: ReadonlyArray<ReadonlyArray<Rule>>,
  capability: Capability
): RuleEffect => {
  const configured = rulesets[0]
  let configuredEffect: RuleEffect = "ask"
  for (const rule of configured ?? []) {
    if (matches(rule.pattern, capability)) {
      configuredEffect = rule.effect
    }
  }
  if (configuredEffect === "deny") {
    return "deny"
  }

  let effect: RuleEffect = "ask"
  for (const ruleset of rulesets) {
    for (const rule of ruleset) {
      if (matches(rule.pattern, capability)) {
        effect = rule.effect
      }
    }
  }
  return effect
}

/**
 * Constructs a permission request for an exact capability.
 *
 * @category constructors
 * @since 0.1.0
 */
export const permissionRequired = (options: {
  readonly requestId: string
  readonly runId?: string | undefined
  readonly capability: Capability
  readonly tier: EffectTier
  readonly meta?: Readonly<Record<string, unknown>> | undefined
}): PermissionRequired =>
  new PermissionRequired({
    code: "permission_required",
    requestId: options.requestId,
    runId: options.runId,
    capability: options.capability,
    tier: options.tier,
    meta: { ...options.meta }
  })

/**
 * Constructs a denied permission failure.
 *
 * @category constructors
 * @since 0.1.0
 */
export const permissionDenied = (capability: Capability, reason: string): PermissionDenied =>
  new PermissionDenied({
    code: "permission_denied",
    capability,
    reason
  })
