/**
 * @since 0.1.0
 *
 * Host domain errors, shaped after `effect/PlatformError`.
 *
 * Effect's platform errors carry normalized operation data — a stable `_tag`
 * reason, the `module` and `method` that failed, a human `description`, and the
 * original `cause` — and are constructed through small helpers rather than
 * `new`. We mirror that exactly, with two deliberate deviations:
 *
 *  - the normalized reason lives in a `code` field rather than a nested
 *    `reason._tag`, because ours is a small closed set per service; and
 *  - the classes are `Schema.TaggedErrorClass`, not `Data.TaggedError`, because
 *    Host failures cross the durability boundary and must round-trip.
 *
 * Codes are a STABLE public contract: callers branch on them, step keys digest
 * them, UIs map them to remediation. Never repurpose a code — add one.
 */
import { Schema } from "effect"

/** @category models */
export const ShellErrorCode = Schema.Literals([
  "aborted",
  "timeout",
  "shell_unavailable",
  "spawn_error",
  "unknown"
])

/** @category models */
export type ShellErrorCode = typeof ShellErrorCode.Type

/** @category models */
export class ShellError extends Schema.TaggedErrorClass<ShellError>()("flows/host/ShellError", {
  code: ShellErrorCode,
  module: Schema.optional(Schema.String),
  method: Schema.optional(Schema.String),
  message: Schema.String,
  command: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Number)
}) {}

/** @category models */
export const PtyErrorCode = Schema.Literals(["unsupported", "exited", "not_found", "unknown"])

/** @category models */
export type PtyErrorCode = typeof PtyErrorCode.Type

/** @category models */
export class PtyError extends Schema.TaggedErrorClass<PtyError>()("flows/host/PtyError", {
  code: PtyErrorCode,
  module: Schema.optional(Schema.String),
  method: Schema.optional(Schema.String),
  message: Schema.String,
  exitCode: Schema.optional(Schema.Number)
}) {}

/** @category models */
export const JjErrorCode = Schema.Literals(["not_installed", "conflict", "invalid_ref", "unknown"])

/** @category models */
export type JjErrorCode = typeof JjErrorCode.Type

/** @category models */
export class JjError extends Schema.TaggedErrorClass<JjError>()("flows/host/JjError", {
  code: JjErrorCode,
  module: Schema.optional(Schema.String),
  method: Schema.optional(Schema.String),
  message: Schema.String,
  /** The jj command that produced the failure, when one was run. */
  command: Schema.optional(Schema.String)
}) {}

/** Every failure the Host layer is allowed to surface. @category models */
export type HostError = ShellError | PtyError | JjError

/** Formats operation data the way `PlatformError` does. */
const format = (code: string, module: string, method: string, description?: string): string =>
  `${code}: ${module}.${method}${description ? `: ${description}` : ""}`

/**
 * Creates a `ShellError` from a failed shell operation.
 * @category constructors
 */
export const shellError = (options: {
  readonly code: ShellErrorCode
  readonly module?: string | undefined
  readonly method: string
  readonly description?: string | undefined
  readonly command?: string | undefined
  readonly exitCode?: number | undefined
}): ShellError => {
  const module = options.module ?? "Shell"
  return new ShellError({
    code: options.code,
    module,
    method: options.method,
    message: format(options.code, module, options.method, options.description),
    command: options.command,
    exitCode: options.exitCode
  })
}

/**
 * Creates a `PtyError` from a failed pseudo-terminal operation.
 * @category constructors
 */
export const ptyError = (options: {
  readonly code: PtyErrorCode
  readonly module?: string | undefined
  readonly method: string
  readonly description?: string | undefined
  readonly exitCode?: number | undefined
}): PtyError => {
  const module = options.module ?? "Pty"
  return new PtyError({
    code: options.code,
    module,
    method: options.method,
    message: format(options.code, module, options.method, options.description),
    exitCode: options.exitCode
  })
}

/**
 * Creates a `JjError` from a failed jj operation.
 * @category constructors
 */
export const jjError = (options: {
  readonly code: JjErrorCode
  readonly module?: string | undefined
  readonly method: string
  readonly description?: string | undefined
  readonly command?: string | undefined
}): JjError => {
  const module = options.module ?? "Jj"
  return new JjError({
    code: options.code,
    module,
    method: options.method,
    message: format(options.code, module, options.method, options.description),
    command: options.command
  })
}
