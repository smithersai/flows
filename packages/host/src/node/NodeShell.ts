/**
 * Node.js `Shell` layer for programs that run commands on the host.
 *
 * The exported layer satisfies the platform-independent `Shell` service with
 * `node:child_process`-backed process execution: a buffered `exec` and a
 * streaming variant that emits tagged stdout/stderr chunks. Effects still call
 * the service from `../Shell.ts`; this module only chooses the Node
 * implementation.
 *
 * Cancellation is scope closure. `exec` and `stream` terminate the detached
 * process group and wait for `close`, so descendants cannot outlive an
 * interrupted fiber or retain its pipes. This follows Effect's
 * `NodeChildProcessSpawner` group-kill behavior.
 *
 * Governing design: `docs/specs/Concepts/Streaming And Cancellation.md`.
 *
 * @since 1.0.0
 */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Queue from "effect/Queue"
import * as Stream from "effect/Stream"
import * as ChildProcess from "node:child_process"
import { ShellError } from "../HostError.ts"
import { Shell } from "../Shell.ts"

/**
 * Maps a Node `ErrnoException` onto the stable `ShellError` codes, the way
 * `NodeFileSystem` maps errno onto `SystemError`.
 */
const handleErrnoException = (method: string) => (error: NodeJS.ErrnoException): ShellError =>
  new ShellError({
    code: error.code === "ENOENT" || error.code === "EACCES" ? "shell_unavailable" : "spawn_error",
    message: `Shell.${method}: ${error.message}`
  })

const shellFile = (): string => process.platform === "win32" ? "cmd.exe" : "/bin/sh"

const shellArgs = (command: string): Array<string> =>
  process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command]

interface ExecOptions {
  readonly cwd?: string | undefined
  readonly env?: Record<string, string> | undefined
  readonly timeoutMs?: number | undefined
  readonly stdin?: string | undefined
}

const spawn = (command: string, options: ExecOptions): ChildProcess.ChildProcess =>
  ChildProcess.spawn(shellFile(), shellArgs(command), {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32"
  })

const feedStdin = (child: ChildProcess.ChildProcess, stdin: string | undefined): void => {
  // `stdio: ["pipe", ...]` always yields a writable stdin; the optional chain is
  // the same null-tolerance the stdout/stderr wiring below uses.
  if (stdin !== undefined) child.stdin?.write(stdin)
  child.stdin?.end()
}

const terminate = (child: ChildProcess.ChildProcess): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resume(Effect.void)
      return
    }
    // `once` detaches itself, and Effect runs this finalizer uninterruptibly,
    // so there is no path on which the listener outlives the termination.
    child.once("close", () => resume(Effect.void))
    if (process.platform === "win32") {
      ChildProcess.execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      })
    } else {
      try {
        process.kill(-child.pid!, "SIGKILL")
      } catch {
        child.kill("SIGKILL")
      }
    }
  })

// == exec

const execUnbounded = (command: string, options: ExecOptions) =>
  Effect.callback<{ stdout: string; stderr: string; exitCode: number }, ShellError>((resume) => {
    let child: ChildProcess.ChildProcess
    try {
      child = spawn(command, options)
    } catch (error) {
      resume(Effect.fail(handleErrnoException("exec")(error as NodeJS.ErrnoException)))
      return
    }

    let stdout = ""
    let stderr = ""
    let settled = false

    const settle = (
      effect: Effect.Effect<{ stdout: string; stderr: string; exitCode: number }, ShellError>
    ): void => {
      if (settled) return
      settled = true
      resume(effect)
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    child.on("error", (error: NodeJS.ErrnoException) => settle(Effect.fail(handleErrnoException("exec")(error))))
    // `close`, not `exit`: both pipes have drained by then.
    child.on("close", (code: number | null) => settle(Effect.succeed({ stdout, stderr, exitCode: code ?? 1 })))

    feedStdin(child, options.stdin)

    return terminate(child)
  })

const exec = (command: string, options: ExecOptions = {}) =>
  options.timeoutMs === undefined
    ? execUnbounded(command, options)
    : Effect.timeoutOrElse(execUnbounded(command, options), {
      duration: options.timeoutMs,
      orElse: () =>
        Effect.fail(
          new ShellError({
            code: "timeout",
            message: `Shell.exec: \`${command}\` exceeded ${options.timeoutMs}ms`
          })
        )
    })

// == execStream

const execStreamUnbounded = (command: string, options: ExecOptions) =>
  Stream.callback<{ kind: "stdout" | "stderr"; chunk: Uint8Array }, ShellError>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const child = spawn(command, options)
        const emit = (kind: "stdout" | "stderr") => (chunk: Buffer) => {
          Queue.offerUnsafe(queue, { kind, chunk: new Uint8Array(chunk) })
        }
        child.stdout?.on("data", emit("stdout"))
        child.stderr?.on("data", emit("stderr"))
        child.on("error", (error: NodeJS.ErrnoException) => {
          Queue.failCauseUnsafe(queue, Cause.fail(handleErrnoException("execStream")(error)))
        })
        child.on("close", () => Queue.endUnsafe(queue))
        feedStdin(child, options.stdin)
        return child
      }),
      terminate
    )
  )

const execStream = (command: string, options: ExecOptions = {}) => {
  const stream = execStreamUnbounded(command, options)
  return options.timeoutMs === undefined
    ? stream
    : stream.pipe(
      Stream.interruptWhen(
        Effect.sleep(options.timeoutMs).pipe(
          Effect.andThen(
            Effect.fail(
              new ShellError({
                code: "timeout",
                message: `Shell.stream: \`${command}\` exceeded ${options.timeoutMs}ms`
              })
            )
          )
        )
      )
    )
}

/**
 * Provides the `Shell` service backed by Node child processes.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<Shell> = Layer.succeed(Shell)({ exec, stream: execStream })
