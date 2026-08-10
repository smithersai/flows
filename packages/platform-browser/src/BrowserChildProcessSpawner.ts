/**
 * Browser implementation of Effect's `ChildProcessSpawner` service.
 *
 * A browser tab cannot fork a process. What it can do is run a command line
 * through an in-page bash interpreter — in practice **just-bash** — over the
 * same virtual filesystem `BrowserFileSystem` is mounted on. This module adapts
 * that interpreter into a `ChildProcessSpawner` layer so `ChildProcess`
 * commands work in the browser the way they do under `NodeChildProcessSpawner`.
 *
 * **The divergences are real and are not hidden.** just-bash is a
 * buffered, run-to-completion API with no process table:
 *
 * - **No incremental output.** `spawn` runs the command to completion and the
 *   returned handle replays the captured output: `stdout` and `stderr` each
 *   emit at most one chunk, and `all` is `stdout` followed by `stderr` rather
 *   than a live interleaving. `isRunning` is therefore always `false` by the
 *   time a caller can observe it. The `stdout`/`stderr` dispositions still
 *   mean what they mean under `NodeChildProcessSpawner` — `"inherit"` and
 *   `"ignore"` yield an empty stream, and a `Sink` is transduced through —
 *   they are just applied to captured text rather than to a live readable.
 * - **No stdin.** `stdin` is a `Sink` that fails, and a command that supplies a
 *   `Stream` for stdin is rejected at spawn time rather than losing its input
 *   silently.
 * - **No signals.** just-bash cannot abort an in-flight call, so each run
 *   executes inside a serialized, uninterruptible boundary: interruption and
 *   `Effect.timeout` both wait for the interpreter to finish before they
 *   report, and callers never observe completion while hidden mutation of the
 *   virtual filesystem is still running. `kill` fails for the same reason —
 *   there is no signal to deliver.
 * - **No process identity.** `pid` is a per-layer counter, not an OS pid, and
 *   `unref` is a no-op: there is no parent process reference count in a tab.
 * - **No pipelines between processes.** A `PipedCommand` is rejected; write the
 *   pipeline as a single command line and let the interpreter parse the `|`.
 * - **No extra file descriptors.** `getInputFd` returns `Sink.drain` and
 *   `getOutputFd` returns `Stream.empty` — the same answer
 *   `NodeChildProcessSpawner` gives for a descriptor that was never configured.
 * - **`extendEnv` is ignored.** There is no ambient process environment in a
 *   tab to extend; only `env` reaches the interpreter.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as PlatformError from "effect/PlatformError"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import {
  ChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId
} from "effect/unstable/process/ChildProcessSpawner"

/**
 * The slice of a `just-bash` interpreter instance this module depends on.
 *
 * Satisfied by the `Bash` class exported from the **`just-bash`** npm package
 * (`new Bash({ fs })`). We take an instance rather than the package so the
 * browser bundle owns construction — mounting the interpreter on the *same*
 * virtual filesystem {@link BrowserFileSystem} adapts — and so tests can hand
 * us a stub.
 *
 * @category models
 * @since 0.1.0
 */
export interface JustBashLike {
  /** Run a command line through the interpreter and return its captured result. */
  readonly run: (
    command: string,
    opts?: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> }
  ) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>
}

const encoder = new TextEncoder()

/** A capability just-bash does not have, reported as a system failure. */
const unsupported = (method: string, description: string): PlatformError.PlatformError =>
  PlatformError.systemError({ _tag: "Unknown", module: "ChildProcess", method, description })

/** Caller input this backend cannot honour, rejected before anything runs. */
const rejected = (method: string, description: string): PlatformError.PlatformError =>
  PlatformError.badArgument({ module: "ChildProcess", method, description })

/**
 * POSIX single-quote escaping, so `args` keep argv semantics on a backend whose
 * only entry point is a command line.
 */
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

/**
 * The command line handed to the interpreter.
 *
 * Without `shell`, the command and its arguments are quoted so that a spawn is
 * literal argv the way `NodeChildProcessSpawner` makes it. With `shell`, they
 * are joined verbatim, mirroring how Node hands `sh -c` an unquoted line.
 */
const commandLine = (command: ChildProcess.StandardCommand): string => {
  const parts = [command.command, ...command.args]
  const shell = command.options.shell
  return shell === undefined || shell === false ? parts.map(quote).join(" ") : parts.join(" ")
}

/** `true` when the caller wired a `Stream` into stdin, in any of its shapes. */
const suppliesStdin = (options: ChildProcess.CommandOptions): boolean => {
  const stdin = options.stdin
  if (stdin === undefined || typeof stdin === "string") return false
  return Stream.isStream(stdin) || Stream.isStream(stdin.stream)
}

/** `env` without the `undefined` values just-bash has no way to represent. */
const resolveEnvironment = (
  options: ChildProcess.CommandOptions
): Record<string, string> | undefined => {
  if (options.env === undefined) return undefined
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(options.env)) {
    if (value !== undefined) env[key] = value
  }
  return env
}

/**
 * Captured output as a stream of at most one chunk, with the caller's
 * disposition for that stream applied.
 *
 * The dispositions mean here what they mean under `NodeChildProcessSpawner`.
 * Node only hands back a readable for `"pipe"`; `"inherit"` and `"ignore"`
 * leave `childProcess.stdout` null, which that implementation turns into
 * `Stream.empty` — so they do the same here, even though the interpreter has
 * already captured the text either way. A `Sink` is transduced through, the way
 * Node transduces the readable it wrapped.
 */
const captured = (
  text: string,
  option: ChildProcess.CommandOutput | { readonly stream?: ChildProcess.CommandOutput | undefined } | undefined
): Stream.Stream<Uint8Array, PlatformError.PlatformError> => {
  const disposition = option === undefined || typeof option === "string" || Sink.isSink(option)
    ? option
    : option.stream
  const stream: Stream.Stream<Uint8Array, PlatformError.PlatformError> = Stream.fromArray(
    text === "" ? [] : [encoder.encode(text)]
  )
  if (disposition === undefined || disposition === "pipe" || disposition === "overlapped") return stream
  if (Sink.isSink(disposition)) return Stream.transduce(stream, disposition)
  return Stream.empty
}

const make = (bash: JustBashLike) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    /**
     * just-bash cannot abort an in-flight interpreter call, so runs are
     * serialized: a second `spawn` waits rather than mutating the virtual
     * filesystem underneath the first.
     */
    const gate = Semaphore.makeUnsafe(1)
    let pid = 0

    const resolveWorkingDirectory = Effect.fnUntraced(
      function*(options: ChildProcess.CommandOptions) {
        if (options.cwd === undefined) return undefined
        // Validate that the specified directory is accessible
        yield* fs.access(options.cwd)
        return path.resolve(options.cwd)
      }
    )

    const spawnCommand: (
      command: ChildProcess.Command
    ) => Effect.Effect<
      ChildProcessHandle,
      PlatformError.PlatformError,
      Scope.Scope
    > = Effect.fnUntraced(function*(cmd) {
      if (cmd._tag === "PipedCommand") {
        return yield* Effect.fail(rejected(
          "spawn",
          "just-bash has no process table to pipe between; express the pipeline as a single command line"
        ))
      }
      if (suppliesStdin(cmd.options)) {
        return yield* Effect.fail(rejected("spawn", "just-bash cannot supply stdin to a command"))
      }

      const cwd = yield* resolveWorkingDirectory(cmd.options)
      const env = resolveEnvironment(cmd.options)
      const line = commandLine(cmd)

      const result = yield* gate.withPermit(
        Effect.uninterruptible(
          Effect.tryPromise({
            try: () =>
              bash.run(line, {
                ...(cwd === undefined ? {} : { cwd }),
                ...(env === undefined ? {} : { env })
              }),
            catch: (cause) =>
              PlatformError.systemError({
                _tag: "Unknown",
                module: "ChildProcess",
                method: "spawn",
                description: cause instanceof Error ? cause.message : String(cause),
                cause
              })
          })
        )
      )

      const stdout = captured(result.stdout, cmd.options.stdout)
      const stderr = captured(result.stderr, cmd.options.stderr)

      return makeHandle({
        pid: ProcessId(++pid),
        exitCode: Effect.succeed(ExitCode(result.exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.fail(unsupported("kill", "just-bash cannot signal a command it is running")),
        stdin: Sink.fail(unsupported("stdin", "just-bash cannot supply stdin to a command")),
        stdout,
        stderr,
        all: Stream.concat(stdout, stderr),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void)
      })
    })

    return makeSpawner(spawnCommand)
  })

/**
 * Provides the `ChildProcessSpawner` service backed by a just-bash interpreter.
 *
 * `FileSystem` and `Path` are required for the same reason
 * `NodeChildProcessSpawner` requires them: `cwd` is validated and resolved
 * before the command runs. Provide the `BrowserFileSystem` layer mounted on the
 * very filesystem the interpreter writes through, or the two will disagree
 * about what exists.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  bash: JustBashLike
): Layer.Layer<ChildProcessSpawner, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(ChildProcessSpawner, make(bash))
