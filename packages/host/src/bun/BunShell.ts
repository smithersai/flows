/**
 * Bun `Shell` implementation backed by `Bun.spawn`.
 *
 * Buffered and streaming executions share the same lifecycle rules: stdin is
 * written and closed, timeout kills the child and reports the existing
 * `"timeout"` code, and interruption closes the Effect scope and kills the
 * child through a finalizer. Node-based test and import tooling receives the
 * equivalent Node implementation; a Bun runtime always selects `Bun.spawn`.
 *
 * @since 0.1.0
 */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Queue from "effect/Queue"
import * as Stream from "effect/Stream"
import { ShellError } from "../HostError.ts"
import * as NodeShell from "../node/NodeShell.ts"
import { Shell } from "../Shell.ts"
import type { ShellChunk, ShellOptions, ShellResult } from "../Shell.ts"

/**
 * The pieces of `Bun.spawn`'s subprocess handle this module uses.
 *
 * @category models
 * @since 0.1.0
 */
export interface BunStdin {
  readonly write: (data: string | Uint8Array) => number
  readonly end: () => void
}

/**
 * @category models
 * @since 0.1.0
 */
export interface BunSubprocess {
  readonly stdin: BunStdin
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
  readonly killed: boolean
  readonly kill: (signal?: string | number) => void
}

/**
 * @category models
 * @since 0.1.0
 */
export interface BunSpawnOptions {
  readonly cmd: ReadonlyArray<string>
  readonly cwd?: string | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly stdin: "pipe"
  readonly stdout: "pipe"
  readonly stderr: "pipe"
}

/**
 * The `Bun` global reduced to the one function this module needs, so the
 * implementation can be constructed and tested off a Bun runtime.
 *
 * @category models
 * @since 0.1.0
 */
export interface BunRuntime {
  readonly spawn: (options: BunSpawnOptions) => BunSubprocess
}

const globalRuntime = (): BunRuntime => {
  const value: unknown = Reflect.get(globalThis, "Bun")
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    throw new Error("Bun runtime is unavailable")
  }
  const spawn: unknown = Reflect.get(value, "spawn")
  if (typeof spawn !== "function") throw new Error("Bun.spawn is unavailable")
  return { spawn: spawn.bind(value) as BunRuntime["spawn"] }
}

const shellCommand = (command: string): ReadonlyArray<string> =>
  process.platform === "win32"
    ? ["cmd.exe", "/d", "/s", "/c", command]
    : ["/bin/sh", "-c", command]

const toShellError = (method: string, command: string) => (cause: unknown): ShellError =>
  new ShellError({
    code: cause instanceof Error && cause.message.includes("Bun") ? "shell_unavailable" : "spawn_error",
    module: "BunShell",
    method,
    message: cause instanceof Error ? cause.message : String(cause),
    command
  })

const timeoutError = (method: string, command: string, timeoutMs: number): ShellError =>
  new ShellError({
    code: "timeout",
    module: "BunShell",
    method,
    message: `Shell.${method}: \`${command}\` exceeded ${timeoutMs}ms`,
    command
  })

const spawn = (bun: BunRuntime, command: string, options: ShellOptions): BunSubprocess =>
  bun.spawn({
    cmd: shellCommand(command),
    cwd: options.cwd,
    env: options.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe"
  })

const feedStdin = (subprocess: BunSubprocess, stdin: string | undefined): void => {
  if (stdin !== undefined) subprocess.stdin.write(stdin)
  subprocess.stdin.end()
}

const killUnsafe = (subprocess: BunSubprocess): void => {
  if (!subprocess.killed) subprocess.kill("SIGKILL")
}

const readText = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let value = ""
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) return value + decoder.decode()
      value += decoder.decode(next.value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

const makeExec = (bun: BunRuntime): Shell["exec"] =>
  Effect.fn("BunShell.exec")((command: string, options: ShellOptions = {}): Effect.Effect<ShellResult, ShellError> =>
    Effect.callback<ShellResult, ShellError>((resume) => {
      let subprocess: BunSubprocess
      try {
        subprocess = spawn(bun, command, options)
      } catch (cause) {
        resume(Effect.fail(toShellError("exec", command)(cause)))
        return
      }

      let timedOut = false
      let settled = false
      const timer = options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
          timedOut = true
          killUnsafe(subprocess)
        }, options.timeoutMs)

      const settle = (effect: Effect.Effect<ShellResult, ShellError>): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        resume(effect)
      }

      try {
        feedStdin(subprocess, options.stdin)
      } catch (cause) {
        killUnsafe(subprocess)
        settle(Effect.fail(toShellError("exec", command)(cause)))
      }

      void Promise.all([
        readText(subprocess.stdout),
        readText(subprocess.stderr),
        subprocess.exited
      ]).then(
        ([stdout, stderr, exitCode]) =>
          settle(
            timedOut && options.timeoutMs !== undefined
              ? Effect.fail(timeoutError("exec", command, options.timeoutMs))
              : Effect.succeed({ stdout, stderr, exitCode })
          ),
        (cause: unknown) => settle(Effect.fail(toShellError("exec", command)(cause)))
      )

      return Effect.sync(() => {
        if (timer !== undefined) clearTimeout(timer)
        killUnsafe(subprocess)
      })
    })
  )

const makeStream =
  (bun: BunRuntime): Shell["stream"] =>
  (command: string, options: ShellOptions = {}): Stream.Stream<ShellChunk, ShellError> =>
    Stream.callback<ShellChunk, ShellError>((queue) =>
      /**
       * The spawn failure is reported through the queue, not by failing the
       * acquire: an `acquireRelease` whose acquire fails inside
       * `Stream.callback` leaves the consumer waiting on a queue nothing will
       * ever end. `NodeShell.execStreamUnbounded` has the same shape for the
       * same reason.
       */
      Effect.acquireRelease(
        Effect.sync(() => {
          let settled = false
          let subprocess: BunSubprocess
          try {
            subprocess = spawn(bun, command, options)
          } catch (cause) {
            Queue.failCauseUnsafe(queue, Cause.fail(toShellError("execStream", command)(cause)))
            return { subprocess: undefined, timer: undefined }
          }
          {
            const fail = (error: ShellError): void => {
              if (settled) return
              settled = true
              Queue.failCauseUnsafe(queue, Cause.fail(error))
            }

            const pump = async (
              kind: ShellChunk["kind"],
              readable: ReadableStream<Uint8Array>
            ): Promise<void> => {
              const reader = readable.getReader()
              try {
                while (true) {
                  const next = await reader.read()
                  if (next.done) return
                  Queue.offerUnsafe(queue, { kind, chunk: next.value })
                }
              } catch (cause) {
                fail(toShellError("execStream", command)(cause))
              } finally {
                reader.releaseLock()
              }
            }

            const timeoutMs = options.timeoutMs
            const timer = timeoutMs === undefined
              ? undefined
              : setTimeout(() => {
                fail(timeoutError("execStream", command, timeoutMs))
                killUnsafe(subprocess)
              }, timeoutMs)

            try {
              feedStdin(subprocess, options.stdin)
            } catch (cause) {
              fail(toShellError("execStream", command)(cause))
              killUnsafe(subprocess)
            }

            void Promise.all([
              pump("stdout", subprocess.stdout),
              pump("stderr", subprocess.stderr),
              subprocess.exited
            ]).then(
              () => {
                if (timer !== undefined) clearTimeout(timer)
                if (!settled) {
                  settled = true
                  Queue.endUnsafe(queue)
                }
              },
              (cause: unknown) => fail(toShellError("execStream", command)(cause))
            )

            return { subprocess, timer }
          }
        }),
        ({ subprocess, timer }) =>
          Effect.sync(() => {
            if (timer !== undefined) clearTimeout(timer)
            if (subprocess !== undefined) killUnsafe(subprocess)
          })
      )
    )

/**
 * Builds a `Shell` over an explicit Bun runtime.
 *
 * The runtime is a parameter, not the `Bun` global, so every `Bun.spawn` path —
 * buffered and streaming execution, stdin, the timeout kill, and the interrupt
 * finalizer — is constructible and testable under Node, where `layer` selects
 * the Node implementation instead.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (bun: BunRuntime): Shell =>
  Shell.of({
    exec: makeExec(bun),
    stream: makeStream(bun)
  })

/**
 * Provides the `Shell` service backed by `Bun.spawn`.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<Shell> = Layer.suspend(() =>
  Reflect.has(globalThis, "Bun")
    // Resolved per spawn, so a `Bun` global without `spawn` still surfaces as a
    // `shell_unavailable` failure rather than a layer-construction defect.
    ? Layer.succeed(Shell)(make({ spawn: (spawnOptions) => globalRuntime().spawn(spawnOptions) }))
    : NodeShell.layer
)
