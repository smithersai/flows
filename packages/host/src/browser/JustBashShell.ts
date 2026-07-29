import { Duration, Effect, Layer, Semaphore, Stream } from "effect"
import { ShellError } from "../HostError.ts"
import { Shell, type ShellChunk, type ShellOptions, type ShellResult } from "../Shell.ts"

/**
 * The slice of a `just-bash` interpreter instance we depend on.
 *
 * Satisfied by the `Bash` class exported from the **`just-bash`** npm package
 * (`new Bash({ fs })`). We take an instance rather than the package so the
 * browser bundle owns construction — and so tests can hand us a stub.
 *
 * `flue` wraps the same object in `reference/flue/packages/runtime/src/sandbox.ts`
 * (`bashFactoryToSessionEnv`); this is that idea with Effect's error channel
 * instead of thrown exceptions.
 */
export interface JustBashLike {
  /** Run a command line through the interpreter and return its captured result. */
  readonly run: (
    command: string,
    opts?: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> }
  ) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>
  /** Current working directory of the interpreter, used when no `cwd` is given. */
  readonly getCwd?: () => string
}

const encoder = new TextEncoder()

/**
 * just-bash cannot abort an in-flight interpreter call. The adapter therefore
 * runs each call in an uninterruptible, serialized boundary. Timeout and fiber
 * interruption wait for that boundary to finish before reporting, so callers
 * never observe completion while hidden VFS mutation is still running.
 */
const withTimeout = (
  self: Effect.Effect<ShellResult, ShellError>,
  command: string,
  timeoutMs: number | undefined
): Effect.Effect<ShellResult, ShellError> =>
  timeoutMs === undefined
    ? self
    : Effect.timeoutOrElse(self, {
      duration: Duration.millis(timeoutMs),
      orElse: () =>
        Effect.fail(
          new ShellError({
            code: "timeout",
            message: `command exceeded ${timeoutMs}ms`,
            command
          })
        )
    })

const runOnce = (
  bash: JustBashLike,
  gate: Semaphore.Semaphore,
  command: string,
  opts: ShellOptions | undefined
): Effect.Effect<ShellResult, ShellError> =>
  withTimeout(
    gate.withPermit(
      Effect.uninterruptible(
        Effect.tryPromise({
          try: () =>
            bash.run(command, {
              ...(opts?.cwd === undefined ? {} : { cwd: opts.cwd }),
              ...(opts?.env === undefined ? {} : { env: opts.env })
            }),
          catch: (cause) =>
            new ShellError({
              code: "spawn_error",
              message: cause instanceof Error ? cause.message : String(cause),
              command
            })
        })
      )
    ),
    command,
    opts?.timeoutMs
  )

/**
 * `Shell` backed by an in-browser bash interpreter.
 *
 * Deliberately not supported: `stdin`. just-bash runs a command line to
 * completion with no interactive input, so a caller that passes `stdin` gets a
 * `shell_unavailable` failure rather than silently losing its input.
 */
export const layer = (bash: JustBashLike): Layer.Layer<Shell> => {
  const gate = Semaphore.makeUnsafe(1)
  return Layer.succeed(Shell)({
    exec: (command, opts) =>
      opts?.stdin === undefined
        ? runOnce(bash, gate, command, opts)
        : Effect.fail(
          new ShellError({
            code: "shell_unavailable",
            message: "just-bash cannot supply stdin to a command",
            command
          })
        ),
    /**
     * just-bash buffers: there is no incremental output to observe. We keep the
     * contract honest by emitting the whole of stdout then the whole of stderr
     * as one chunk each once the command finishes.
     */
    stream: (command, opts) =>
      Stream.unwrap(
        Effect.map(runOnce(bash, gate, command, opts), (result) => {
          const chunks: Array<ShellChunk> = []
          if (result.stdout !== "") {
            chunks.push({ kind: "stdout", chunk: encoder.encode(result.stdout) })
          }
          if (result.stderr !== "") {
            chunks.push({ kind: "stderr", chunk: encoder.encode(result.stderr) })
          }
          return Stream.fromArray(chunks)
        })
      )
  })
}
