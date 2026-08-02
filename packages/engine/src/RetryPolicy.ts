/**
 * Defines data-shaped retry policies for durable activity retries.
 *
 * A `RetryPolicy` is a plain value — initial interval, backoff factor, cap,
 * optional maximum attempts, optional jitter, and optional non-retryable
 * error tags — so the next retry delay can be derived from a persisted
 * attempt count instead of fiber-local `Schedule` state. `nextDelay` mirrors
 * Temporal's `ExponentialRetryPolicy.ComputeNextDelay` formula, and `decide`
 * is the engine's single retry decision point: the core default a pluggable
 * `resolveRetry` resolution can later dispatch in front of.
 *
 * Vault: [[Failure Policy]] (`docs/specs/Concepts/Failure Policy.md`) and
 * [[Engine Hardening Round 1]]
 * (`docs/specs/Concepts/Engine Hardening Round 1.md`), section 6.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Random from "effect/Random"
import * as Schema from "effect/Schema"

/**
 * Data-shaped retry policy schema.
 *
 * The delay before attempt `n + 1` is
 * `min(initialMs * factor^(n - 1), maxMs)`, where `n` is the attempt that
 * just failed. `maxAttempts` bounds the total number of attempts;
 * `expirationMs` bounds the total wall-clock retry duration
 * (schedule-to-close, mirroring Temporal's `expirationInterval`);
 * `jitterRatio` spreads the final portion of each delay uniformly;
 * `nonRetryable` lists error tags that must never be retried.
 *
 * @category models
 * @since 0.1.0
 */
export const RetryPolicy = Schema.Struct({
  initialMs: Schema.Number,
  factor: Schema.Number,
  maxMs: Schema.Number,
  maxAttempts: Schema.optional(Schema.Number),
  expirationMs: Schema.optional(Schema.Number),
  jitterRatio: Schema.optional(Schema.Number),
  nonRetryable: Schema.optional(Schema.Array(Schema.String))
})

/**
 * The value form of a {@link RetryPolicy}.
 *
 * @category models
 * @since 0.1.0
 */
export type RetryPolicy = typeof RetryPolicy.Type

/**
 * Creates a `RetryPolicy` value.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: {
  readonly initialMs: number
  readonly factor: number
  readonly maxMs: number
  readonly maxAttempts?: number | undefined
  readonly expirationMs?: number | undefined
  readonly jitterRatio?: number | undefined
  readonly nonRetryable?: ReadonlyArray<string> | undefined
}): RetryPolicy => ({
  initialMs: options.initialMs,
  factor: options.factor,
  maxMs: options.maxMs,
  ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
  ...(options.expirationMs !== undefined ? { expirationMs: options.expirationMs } : {}),
  ...(options.jitterRatio !== undefined ? { jitterRatio: options.jitterRatio } : {}),
  ...(options.nonRetryable !== undefined ? { nonRetryable: options.nonRetryable } : {})
})

/**
 * The default engine retry policy.
 *
 * Uses a 200ms initial delay growing by 1.5x, capped at 30s, and never gives
 * up: it declares neither `maxAttempts` nor `expirationMs`. Bound long-lived
 * retries with `make({ ..., expirationMs })` when a wall-clock give-up is
 * required.
 *
 * @category constructors
 * @since 0.1.0
 */
export const defaultRetryPolicy: RetryPolicy = make({
  initialMs: 200,
  factor: 1.5,
  maxMs: 30000
})

/**
 * A retry decision: wait `delayMs` before the next attempt.
 *
 * @category models
 * @since 0.1.0
 */
export interface RetryAfter {
  readonly _tag: "RetryAfter"
  readonly delayMs: number
}

/**
 * A retry decision: stop retrying.
 *
 * @category models
 * @since 0.1.0
 */
export interface GiveUp {
  readonly _tag: "GiveUp"
  readonly reason: "nonRetryable" | "exhausted" | "expired"
}

/**
 * The outcome of the engine's retry decision point.
 *
 * @category models
 * @since 0.1.0
 */
export type RetryDecision = RetryAfter | GiveUp

/**
 * Creates a `RetryAfter` decision.
 *
 * @category constructors
 * @since 0.1.0
 */
export const retryAfter = (delayMs: number): RetryDecision => ({
  _tag: "RetryAfter",
  delayMs
})

/**
 * Creates a `GiveUp` decision.
 *
 * @category constructors
 * @since 0.1.0
 */
export const giveUp = (reason: GiveUp["reason"]): RetryDecision => ({
  _tag: "GiveUp",
  reason
})

/**
 * A retry sequence crossed the policy's `expirationMs` wall-clock bound.
 *
 * @category errors
 * @since 0.1.0
 */
export class RetryPolicyExpired extends Schema.TaggedErrorClass<RetryPolicyExpired>()(
  "@smithers/engine/RetryPolicyExpired",
  {
    code: Schema.Literal("retry_policy_expired").pipe(
      Schema.withConstructorDefault(Effect.succeed("retry_policy_expired"))
    ),
    activityName: Schema.String,
    attempt: Schema.Number,
    expirationMs: Schema.Number,
    lastError: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * A retry sequence exhausted the policy's `maxAttempts` bound.
 *
 * @category errors
 * @since 0.1.0
 */
export class RetryAttemptsExhausted extends Schema.TaggedErrorClass<RetryAttemptsExhausted>()(
  "@smithers/engine/RetryAttemptsExhausted",
  {
    code: Schema.Literal("retry_attempts_exhausted").pipe(
      Schema.withConstructorDefault(Effect.succeed("retry_attempts_exhausted"))
    ),
    activityName: Schema.String,
    attempt: Schema.Number,
    maxAttempts: Schema.Number,
    lastError: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * Computes the delay before attempt `attempt + 1` from the persisted attempt
 * count, mirroring Temporal's `ComputeNextDelay`
 * (`common/backoff/retrypolicy.go`).
 *
 * `attempt` is the 1-based attempt that just failed. Returns `None` when the
 * policy gives up: `maxAttempts` reached, a non-positive computed interval,
 * a cap below the initial interval, or — when the policy declares
 * `expirationMs` and the caller supplies `elapsedMs` — an elapsed duration
 * past the expiration bound. Otherwise the delay is capped to the remaining
 * expiration window, expiring only when that window cannot fit one more
 * full-value (`initialMs`) attempt.
 *
 * Jitter is deterministic-friendly: `options.random` is a `[0, 1)` sample
 * supplied by the caller and defaults to `1`, which leaves the delay at its
 * un-jittered value. Use {@link nextDelayEffect} to sample the `Random`
 * service instead.
 *
 * @category Attempts
 * @since 0.1.0
 */
export const nextDelay = (
  policy: RetryPolicy,
  attempt: number,
  options?: {
    readonly random?: number | undefined
    readonly elapsedMs?: number | undefined
  }
): Option.Option<number> => {
  if (policy.maxAttempts !== undefined && attempt >= policy.maxAttempts) {
    return Option.none()
  }
  if (
    policy.expirationMs !== undefined &&
    options?.elapsedMs !== undefined &&
    options.elapsedMs > policy.expirationMs
  ) {
    return Option.none()
  }
  const raw = policy.initialMs * Math.pow(policy.factor, attempt - 1)
  if (!(raw > 0)) {
    return Option.none()
  }
  let delay = Math.min(raw, policy.maxMs)
  // Temporal caps the delay to the remaining expiration window rather than
  // refusing outright; the below-initial check then expires sequences whose
  // remaining window cannot fit one more full-value attempt.
  if (policy.expirationMs !== undefined && options?.elapsedMs !== undefined) {
    delay = Math.min(delay, Math.max(0, policy.expirationMs - options.elapsedMs))
  }
  if (delay < policy.initialMs) {
    return Option.none()
  }
  if (policy.jitterRatio !== undefined && policy.jitterRatio > 0) {
    const random = options?.random ?? 1
    delay = delay * (1 - policy.jitterRatio) + random * delay * policy.jitterRatio
  }
  return Option.some(delay)
}

/**
 * Computes the next retry delay, sampling the `Random` service for jitter.
 *
 * Deterministic under `Random.withSeed`. Policies without a `jitterRatio`
 * never touch the service.
 *
 * @category Attempts
 * @since 0.1.0
 */
export const nextDelayEffect = (
  policy: RetryPolicy,
  attempt: number,
  options?: { readonly elapsedMs?: number | undefined }
): Effect.Effect<Option.Option<number>> =>
  policy.jitterRatio === undefined || policy.jitterRatio <= 0
    ? Effect.sync(() => nextDelay(policy, attempt, { elapsedMs: options?.elapsedMs }))
    : Effect.map(Random.next, (random) => nextDelay(policy, attempt, { random, elapsedMs: options?.elapsedMs }))

/**
 * Extracts the stable identity tag of an error for non-retryable matching:
 * a string `_tag` property when present, otherwise the `Error` name.
 *
 * @category Attempts
 * @since 0.1.0
 */
export const errorTag = (error: unknown): string | undefined => {
  if (typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string") {
    return error._tag
  }
  if (error instanceof Error) {
    return error.name
  }
  return undefined
}

/**
 * Error tags that are non-retryable by type, under every policy (issue #156).
 *
 * These failures are deterministic: retrying re-runs the identical decision
 * against identical durable state, so every attempt re-fails the same way
 * while re-journalling its evidence — cache corruption is the canonical
 * case, where each retry re-reads the same corrupt row and re-detects the
 * identical corruption. No per-callsite or per-policy opt-out exists;
 * the tags are matched by string so the classification does not invert the
 * package dependency direction.
 *
 * `AttemptEvidenceQuarantined` (issue #171) is the succeeded-attempt-row
 * counterpart: the corrupt row is deliberately never repaired in-band, so
 * retrying is deterministic re-detection. It must reach the driver
 * unretried, which parks the run in the `quarantine` waiting state for an
 * operator instead of failing it.
 *
 * @category Attempts
 * @since 0.1.0
 */
export const defaultNonRetryable: ReadonlyArray<string> = [
  "flows/engine-store/CacheCorruptionDetected",
  "flows/engine-store/AttemptEvidenceQuarantined"
]

/**
 * Whether an error is classified non-retryable — by type (see
 * {@link defaultNonRetryable}) or by the policy's declared tag list.
 *
 * @category Attempts
 * @since 0.1.0
 */
export const isNonRetryable = (policy: RetryPolicy, error: unknown): boolean => {
  const tag = errorTag(error)
  if (tag === undefined) {
    return false
  }
  if (defaultNonRetryable.includes(tag)) {
    return true
  }
  return policy.nonRetryable !== undefined && policy.nonRetryable.includes(tag)
}

/**
 * The pure core of the engine's single retry decision point.
 *
 * Non-retryable classification is evaluated here and nowhere else. This is
 * the default a pluggable `resolveRetry` resolution falls back to when no
 * plugin claims the decision.
 *
 * @category Attempts
 * @since 0.1.0
 */
export const decide = (
  policy: RetryPolicy,
  options: {
    readonly attempt: number
    readonly error: unknown
    readonly random?: number | undefined
    readonly elapsedMs?: number | undefined
  }
): RetryDecision => {
  if (isNonRetryable(policy, options.error)) {
    return giveUp("nonRetryable")
  }
  return Option.match(
    nextDelay(policy, options.attempt, { random: options.random, elapsedMs: options.elapsedMs }),
    {
      onNone: () =>
        // The expiration bound is the only give-up that depends on elapsed
        // time: when dropping it would have allowed another attempt, the
        // sequence expired rather than exhausted.
        Option.isSome(nextDelay(policy, options.attempt, { random: options.random }))
          ? giveUp("expired")
          : giveUp("exhausted"),
      onSome: retryAfter
    }
  )
}

/**
 * Effect form of {@link decide}, sampling the `Random` service for jitter.
 *
 * This is the engine-facing decision function: keep calls to it behind a
 * single decision point so a plugin hook dispatch can later be inserted in
 * front of it without touching call sites.
 *
 * @category Attempts
 * @since 0.1.0
 */
export const decideEffect = (
  policy: RetryPolicy,
  options: {
    readonly attempt: number
    readonly error: unknown
    readonly elapsedMs?: number | undefined
  }
): Effect.Effect<RetryDecision> =>
  policy.jitterRatio === undefined || policy.jitterRatio <= 0
    ? Effect.sync(() => decide(policy, options))
    : Effect.map(Random.next, (random) => decide(policy, { ...options, random }))
