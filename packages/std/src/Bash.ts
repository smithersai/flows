/**
 * Bash flow declaration and portable handler.
 *
 * @since 0.1.0
 */
import * as Flow from "@smthrs/core/Flow"
import type * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as Path from "@smthrs/kernel/Path"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { capability, envelope } from "./internal/Declaration.ts"
import * as Exec from "./internal/Exec.ts"
import { withinEnvelope } from "./internal/Paths.ts"
import { MAX_SHELL_OUTPUT_BYTES, truncateBytes } from "./internal/Text.ts"
import * as Probe from "./Probe.ts"
import * as StdError from "./StdError.ts"

/**
 * Registry name for the bash flow.
 *
 * @category identifiers
 * @since 0.1.0
 */
export const name = "bash"

/**
 * Model-facing description of the bash flow.
 *
 * Capped at 200 characters and read every frame, which is why the
 * invalid-probe contract is not restated here: the cell contract teaches it
 * once, and a result that has one explains itself.
 *
 * @category descriptions
 * @since 0.1.0
 */
export const description =
  "Run a shell command. mode:hermetic checks explicit path tokens against declared reads/writes but does not sandbox the process. mode:unhermetic skips that check. stdout/stderr retain overflow tails."

const Command = Schema.String.annotate({ description: "Shell command string to execute" })
const Cwd = Schema.optional(Schema.String.annotate({ description: "Working directory for the command" }))
const Env = Schema.optional(
  Schema.Record(Schema.String, Schema.String).annotate({ description: "Environment variables for the command" })
)
const TimeoutMs = Schema.optional(
  Schema.Number.annotate({ description: "Wall-clock timeout in milliseconds" })
)

/**
 * Input schema for the bash flow.
 *
 * The mode named `hermetic` requires explicit read and write envelopes for a
 * lexical pre-check; it does not by itself confine the process. Unhermetic mode
 * deliberately omits those declarations so the distinction stays visible in
 * the input shape.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Input = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("hermetic").annotate({
      description: "Lexically pre-check explicit path tokens against declared reads and writes; does not sandbox"
    }),
    command: Command,
    reads: Schema.Array(Schema.String).annotate({ description: "Paths or path globs the command may read" }),
    writes: Schema.Array(Schema.String).annotate({ description: "Paths or path globs the command may write" }),
    cwd: Cwd,
    env: Env,
    timeoutMs: TimeoutMs
  }),
  Schema.Struct({
    mode: Schema.Literal("unhermetic").annotate({
      description: "Run without a declared filesystem envelope as an irreversible effect"
    }),
    command: Command,
    cwd: Cwd,
    env: Env,
    timeoutMs: TimeoutMs
  })
])

/**
 * Decoded input accepted by the bash handler.
 *
 * @category models
 * @since 0.1.0
 */
export type Input = typeof Input.Type

/**
 * Output schema for the bash flow.
 *
 * `invalidProbe` is the one field that is not a fact about the process. It is
 * present only when the exit code describes the command rather than the code
 * the command was meant to check, which is the distinction an exit code alone
 * cannot carry. See `Probe`.
 *
 * The `<stream>Truncated` flags are a wire convention, not a display detail.
 * A truncated capture is a fragment of what the process printed, and the
 * harness reads these flags to refuse a later write of those exact bytes —
 * `@smthrs/harness/TruncatedOutput` is the consuming half. Renaming a flag, or
 * dropping it when the capture is cut, disarms that guard silently.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Output = Schema.Struct({
  exitCode: Schema.Number.annotate({ description: "Command exit code, including non-zero codes" }),
  stdout: Schema.String.annotate({
    description: "Captured stdout; only the tail, and not the whole output, when stdoutTruncated is true"
  }),
  stderr: Schema.String.annotate({
    description: "Captured stderr; only the tail, and not the whole output, when stderrTruncated is true"
  }),
  stdoutTruncated: Schema.Boolean.annotate({
    description:
      "Whether stdout exceeded the capture limit, leaving stdout a fragment that must not be written to a file"
  }),
  stderrTruncated: Schema.Boolean.annotate({
    description:
      "Whether stderr exceeded the capture limit, leaving stderr a fragment that must not be written to a file"
  }),
  stdoutDroppedBytes: Schema.Number.annotate({ description: "UTF-8 bytes omitted from the start of stdout" }),
  stderrDroppedBytes: Schema.Number.annotate({ description: "UTF-8 bytes omitted from the start of stderr" }),
  invalidProbe: Schema.optional(
    Probe.InvalidProbe.annotate({
      description:
        "Present when the command named something that does not exist, so the non-zero exit is about the command and not about the code under test"
    })
  )
})

/**
 * Decoded output returned by the bash handler.
 *
 * @category models
 * @since 0.1.0
 */
export type Output = typeof Output.Type

/**
 * Static conservative effect envelope for the bash flow.
 *
 * The declaration is the registry-time worst case because the mode is not
 * known until an invocation is decoded.
 *
 * @category effects
 * @since 0.1.0
 */
export const effects = envelope({
  tier: "irreversible",
  mode: "expected",
  reads: [],
  writes: []
})

/**
 * Narrows the effect envelope for a decoded invocation.
 *
 * @category effects
 * @since 0.1.0
 */
export const effectsFor = (input: Input) =>
  input.mode === "hermetic"
    ? envelope({
      tier: "compensable",
      mode: "hermetic",
      reads: input.reads,
      writes: input.writes
    })
    : envelope({
      tier: "irreversible",
      mode: "expected",
      reads: [],
      writes: []
    })

/**
 * Capabilities required by the bash flow.
 *
 * @category capabilities
 * @since 0.1.0
 */
export const capabilities = [capability("proc:spawn", "*")]

/**
 * Declaration-only bash flow.
 *
 * @category flows
 * @since 0.1.0
 */
export const flow = Flow.make({ name, description, input: Input, output: Output, capabilities, effects })

type Access = "read" | "write"

interface PathReference {
  readonly access: Access
  readonly value: string
}

const commandSeparators = new Set(["&&", "||", ";", "|", "&"])
const redirections = new Set([">", ">>", "<", "<<"])
const writeCommands = new Set(["chmod", "chown", "mkdir", "rm", "rmdir", "tee", "touch", "truncate", "unlink"])
const destinationCommands = new Set(["cp", "install", "mv"])

const tokenize = (command: string): ReadonlyArray<string> =>
  command.match(/"(?:\\.|[^"\\])*"|'[^']*'|>>|<<|&&|\|\||[<>;|&]|[^\s<>;|&]+/g) ?? []

const unquote = (token: string): string => {
  const first = token[0]
  const last = token[token.length - 1]
  return token.length >= 2 && (first === "'" || first === "\"") && last === first
    ? token.slice(1, -1)
    : token
}

const pathValue = (token: string): string =>
  unquote(token)
    .replace(/^\$\(+/, "")
    .replace(/[),]+$/, "")

const isPathToken = (path: Path.Path, token: string): boolean =>
  token === "." ||
  token === ".." ||
  token.startsWith("./") ||
  token.startsWith("../") ||
  path.isAbsolute(token) ||
  /^[A-Za-z]:[\\/]/.test(token) ||
  token.includes("/")

const segmentReferences = (path: Path.Path, tokens: ReadonlyArray<string>): ReadonlyArray<PathReference> => {
  const commandIndex = tokens.findIndex((token) =>
    !redirections.has(token) &&
    !token.includes("=") &&
    token !== ""
  )
  if (commandIndex === -1) return []

  const command = path.basename(pathValue(tokens[commandIndex]!))
  const candidates: Array<{ readonly index: number; readonly value: string }> = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (index === commandIndex || redirections.has(token) || token.startsWith("-")) continue
    const value = pathValue(token)
    if (value !== "" && isPathToken(path, value)) candidates.push({ index, value })
  }

  const destinationIndex = destinationCommands.has(command)
    ? candidates[candidates.length - 1]?.index
    : undefined

  return candidates
    // /dev/* is the process plumbing every shell one-liner leans on —
    // `2>/dev/null`, `cat /dev/stdin` — not a workspace effect. Requiring it
    // in the declared write set taught agents to redeclare boilerplate one
    // refused frame at a time.
    .filter(({ value }) => !value.startsWith("/dev/"))
    .map(({ index, value }) => {
      const previous = tokens[index - 1]
      const access: Access = previous === ">" || previous === ">>" ||
          writeCommands.has(command) || destinationIndex === index
        ? "write"
        : "read"
      return { access, value }
    })
}

const commandReferences = (path: Path.Path, command: string): ReadonlyArray<PathReference> => {
  const references: Array<PathReference> = []
  let segment: Array<string> = []
  for (const token of tokenize(command)) {
    if (commandSeparators.has(token)) {
      references.push(...segmentReferences(path, segment))
      segment = []
    } else {
      segment.push(token)
    }
  }
  references.push(...segmentReferences(path, segment))
  return references
}

const isDeclared = (
  declared: ReadonlyArray<string>,
  source: string,
  resolved: string
): boolean => withinEnvelope(declared, source) || withinEnvelope(declared, resolved)

const outsideEnvelope = (
  input: Extract<Input, { readonly mode: "hermetic" }>,
  path: Path.Path
): StdError.StdError | undefined => {
  const base = path.resolve(".")
  const cwd = path.resolve(input.cwd ?? ".")
  // Passing the default explicitly is not a declaration the caller owes. A
  // working directory is where the command runs, not a file it reads, and
  // `cwd: "."` names exactly what omitting `cwd` names — so refusing it asked
  // the caller to list the workspace root among its reads to say nothing at
  // all. Agents hit this constantly: one SWE-bench run spent ten of its
  // forty-eight tool calls re-issuing the same command after
  // "Working directory is outside declared reads: <the workspace root>". A
  // cwd that points somewhere else is still declared or refused.
  if (input.cwd !== undefined && cwd !== base && !isDeclared(input.reads, input.cwd, cwd)) {
    return new StdError.StdError({
      code: "outside_declared_reads",
      message: `Working directory is outside declared reads: ${cwd}`,
      path: cwd
    })
  }

  // The Shell contract currently has no sandbox or access-reporting surface.
  // This lexical scan is intentionally only a fail-closed pre-check for
  // explicit path tokens. It cannot prove confinement; a kernel/host sandbox
  // must eventually enforce and report the complete read and write sets.
  for (const reference of commandReferences(path, input.command)) {
    const resolved = path.isAbsolute(reference.value)
      ? path.normalize(reference.value)
      : path.resolve(cwd, reference.value)
    const declared = reference.access === "write" ? input.writes : input.reads
    if (!isDeclared(declared, reference.value, resolved)) {
      const code = reference.access === "write" ? "outside_declared_writes" : "outside_declared_reads"
      return new StdError.StdError({
        code,
        message: `Command path is outside declared ${reference.access}s: ${resolved}`,
        path: resolved
      })
    }
  }
  return undefined
}

const hostError = (command: string, error: unknown): StdError.StdError => {
  const code = typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined
  const message = error instanceof Error ? error.message : String(error)
  return new StdError.StdError({
    code: code === "timeout" ? "timeout" : "command_failed",
    message: code === "timeout"
      ? `Command timed out: ${command}`
      : `Command failed to start: ${message}`
  })
}

/**
 * Executes a shell command through the permission-aware kernel service.
 *
 * Non-zero exit codes remain successful values. Only timeout, host, permission,
 * and declared-envelope pre-check failures use the typed error channel.
 *
 * @category handlers
 * @since 0.1.0
 */
export const run = Effect.fn("Bash.run")(function*(
  input: Input
): Effect.fn.Return<Output, StdError.StdError, ChildProcessSpawner.ChildProcessSpawner | Path.Path> {
  const path = yield* Path.Path
  if (input.mode === "hermetic") {
    const violation = outsideEnvelope(input, path)
    if (violation !== undefined) return yield* Effect.fail(violation)
  }

  const result = yield* Exec.exec(input.command, {
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs })
  }).pipe(Effect.mapError((error) => hostError(input.command, error)))
  const stdout = truncateBytes(result.stdout, MAX_SHELL_OUTPUT_BYTES, { keep: "tail" })
  const stderr = truncateBytes(result.stderr, MAX_SHELL_OUTPUT_BYTES, { keep: "tail" })
  // Classified against the text this call returns rather than the text it
  // captured, so the evidence line is always quotable from what the caller can
  // read. Truncation keeps the tail, which is where a runner prints its refusal.
  const probe = Probe.classify({ exitCode: result.exitCode, stdout: stdout.text, stderr: stderr.text })
  return {
    exitCode: result.exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    stdoutDroppedBytes: stdout.droppedBytes,
    stderrDroppedBytes: stderr.droppedBytes,
    ...(probe === undefined ? {} : { invalidProbe: probe })
  }
})
