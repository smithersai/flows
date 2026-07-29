/**
 * @since 0.1.0
 *
 * The `Shell` service: run a command on the host and read its output.
 *
 * Contract only — `node/NodeHost.ts`, `browser/BrowserHost.ts` and
 * `test/TestHost.ts` provide the `layer`s. Module shape follows
 * `effect/FileSystem`: the interface and its option/result types are exported
 * beside the service tag, and the module ships the `make` / `makeNoop` /
 * `layerNoop` trio so tests never need a real host.
 */
import { Context, Effect, Layer, Stream } from "effect"
import { shellError } from "./HostError.ts"
import type { ShellError } from "./HostError.ts"

/**
 * Options for a single shell invocation.
 *
 * There is deliberately no `signal` here. Cancellation is fiber interruption:
 * interrupting the fiber running `exec` kills the child process through the
 * implementation's scope finalizer. Nothing in `flows` threads an AbortSignal.
 *
 * @category models
 */
export interface ShellOptions {
  readonly cwd?: string | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  /** Wall-clock budget; exceeding it fails with `ShellError` `timeout`. */
  readonly timeoutMs?: number | undefined
  /** Written to the child's stdin, which is then closed. */
  readonly stdin?: string | undefined
}

/** @category models */
export interface ShellResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/**
 * One chunk of child output, tagged with the stream it came from.
 * @category models
 */
export interface ShellChunk {
  readonly kind: "stdout" | "stderr"
  readonly chunk: Uint8Array
}

/**
 * @category services
 */
export interface Shell {
  /** Runs a command to completion and buffers its output. */
  readonly exec: (command: string, options?: ShellOptions) => Effect.Effect<ShellResult, ShellError>
  /**
   * Runs a command and observes its output as it is produced. The child lives
   * exactly as long as the stream is consumed; interrupting the consumer kills
   * it.
   */
  readonly stream: (command: string, options?: ShellOptions) => Stream.Stream<ShellChunk, ShellError>
}

/**
 * @category services
 * @since 0.1.0
 */
export const Shell: Context.Service<Shell, Shell> = Context.Service("flows/host/Shell")

/**
 * Builds a `Shell` from a core implementation, deriving `stream` from `exec`
 * when the platform cannot stream incrementally.
 *
 * @category constructors
 */
export const make = (impl: Omit<Shell, "stream"> & Partial<Pick<Shell, "stream">>): Shell =>
  Shell.of({
    exec: impl.exec,
    stream: impl.stream ??
      ((command, options) =>
        Stream.fromArrayEffect(
          Effect.map(impl.exec(command, options), (result): ReadonlyArray<ShellChunk> => {
            const encoder = new TextEncoder()
            return [
              { kind: "stdout", chunk: encoder.encode(result.stdout) },
              { kind: "stderr", chunk: encoder.encode(result.stderr) }
            ]
          })
        ))
  })

/**
 * Creates a stub `Shell` for tests. Every method fails with `ShellError`
 * `shell_unavailable` until overridden.
 *
 * @category constructors
 */
export const makeNoop = (overrides: Partial<Shell>): Shell => {
  const unavailable = (method: string, command?: string) =>
    shellError({
      code: "shell_unavailable",
      method,
      description: "no shell in this environment",
      command
    })
  return Shell.of({
    exec: (command) => Effect.fail(unavailable("exec", command)),
    stream: (command) => Stream.fail(unavailable("stream", command)),
    ...overrides
  })
}

/**
 * Provides a stub `Shell` as a `Layer`.
 *
 * @category layers
 */
export const layerNoop = (overrides: Partial<Shell>): Layer.Layer<Shell> => Layer.succeed(Shell)(makeNoop(overrides))
