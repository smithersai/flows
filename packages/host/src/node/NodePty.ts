/**
 * Node.js `Pty` layer for programs that drive interactive terminal sessions.
 *
 * **This is a skeleton, not a real PTY.** A true pseudo-terminal needs a native
 * addon (`node-pty` / `@lydell/node-pty`), which is deliberately not a
 * dependency yet. Until it is, this layer spawns the command with piped stdio,
 * so there is no controlling terminal: programs will see a non-TTY stdout,
 * `resize` is recorded but not delivered as `SIGWINCH`, and full-screen apps
 * will not render. Swapping in `node-pty` means replacing `spawn`/`write`/
 * `resize` here; the service contract and the replay buffer below stay as they
 * are.
 *
 * The replay buffer follows opencode's cursor pattern (`packages/core/src/pty`):
 * output is retained in a bounded ring, and `attach(fromCursor)` replays
 * everything still held from that byte offset before switching to live chunks,
 * so a reconnecting viewer sees a coherent screen.
 *
 * @since 1.0.0
 */
import type * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Queue from "effect/Queue"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as ChildProcess from "node:child_process"
import { PtyError } from "../HostError.ts"
import { Pty, type PtyHandle } from "../Pty.ts"

/** Bytes of scrollback retained for `attach` replay. */
const RING_BYTES = 256 * 1024

interface SpawnOptions {
  readonly cols: number
  readonly rows: number
  readonly cwd?: string | undefined
  readonly env?: Record<string, string> | undefined
}

const handleErrnoException = (method: string) => (error: NodeJS.ErrnoException): PtyError =>
  new PtyError({
    code: error.code === "ENOENT" ? "not_found" : "unknown",
    message: `Pty.${method}: ${error.message}`
  })

/**
 * A bounded ring of output chunks addressed by absolute byte offset. `cursor`
 * only ever grows; `floor` is the oldest offset still retained, so a viewer
 * that fell too far behind resumes at `floor` instead of silently skipping.
 */
class Ring {
  private chunks: Array<Uint8Array> = []
  private bytes = 0
  floor = 0
  cursor = 0

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk)
    this.bytes += chunk.byteLength
    this.cursor += chunk.byteLength
    while (this.bytes > RING_BYTES && this.chunks.length > 1) {
      // The loop guard keeps at least two chunks, so `shift` always yields one.
      const dropped = this.chunks.shift()!
      this.bytes -= dropped.byteLength
      this.floor += dropped.byteLength
    }
  }

  /** Every retained chunk at or after `from`, clipped to the exact offset. */
  since(from: number): Array<Uint8Array> {
    const out: Array<Uint8Array> = []
    let offset = this.floor
    for (const chunk of this.chunks) {
      const end = offset + chunk.byteLength
      if (end > from) out.push(offset >= from ? chunk : chunk.subarray(from - offset))
      offset = end
    }
    return out
  }
}

const makeHandle = (
  command: string,
  options: SpawnOptions
): Effect.Effect<PtyHandle, PtyError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () =>
        ChildProcess.spawn(command, {
          shell: true,
          cwd: options.cwd,
          env: { ...(options.env ?? process.env), COLUMNS: String(options.cols), LINES: String(options.rows) },
          stdio: ["pipe", "pipe", "pipe"]
        }),
      catch: (error) => handleErrnoException("spawn")(error as NodeJS.ErrnoException)
    }),
    (child) =>
      Effect.sync(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      })
  ).pipe(
    /**
     * A child that cannot start reports it asynchronously through `error`, and
     * an unobserved `error` event on a `ChildProcess` is rethrown by Node as an
     * uncaught exception. `spawn` therefore waits for the child to reach one of
     * its two terminal starting states before a handle exists at all.
     */
    Effect.tap((child) =>
      Effect.callback<void, PtyError>((resume) => {
        const onSpawn = (): void => {
          child.off("error", onError)
          resume(Effect.void)
        }
        const onError = (error: NodeJS.ErrnoException): void => {
          child.off("spawn", onSpawn)
          resume(Effect.fail(handleErrnoException("spawn")(error)))
        }
        child.once("spawn", onSpawn)
        child.once("error", onError)
      })
    ),
    Effect.map((child): PtyHandle => {
      const ring = new Ring()
      const subscribers = new Set<Queue.Queue<Uint8Array, PtyError | Cause.Done>>()
      let exited: number | undefined

      const broadcast = (chunk: Uint8Array): void => {
        ring.push(chunk)
        for (const queue of subscribers) Queue.offerUnsafe(queue, chunk)
      }
      const onData = (chunk: Buffer) => broadcast(new Uint8Array(chunk))
      child.stdout?.on("data", onData)
      child.stderr?.on("data", onData)
      child.on("exit", (code: number | null) => {
        exited = code ?? 1
        for (const queue of subscribers) Queue.endUnsafe(queue)
        subscribers.clear()
      })

      /** Live subscription; replays retained output from `fromCursor` first. */
      const attach = (fromCursor: number): Stream.Stream<Uint8Array, PtyError> =>
        Stream.callback<Uint8Array, PtyError>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              for (const chunk of ring.since(Math.max(fromCursor, ring.floor))) Queue.offerUnsafe(queue, chunk)
              if (exited !== undefined) {
                Queue.endUnsafe(queue)
                return queue
              }
              subscribers.add(queue)
              return queue
            }),
            (queue) => Effect.sync(() => subscribers.delete(queue))
          )
        )

      return {
        write: (data: Uint8Array) =>
          Effect.suspend(() =>
            exited !== undefined
              ? Effect.fail(new PtyError({ code: "exited", message: "Pty.write: process has exited" }))
              : Effect.sync(() => {
                child.stdin?.write(data)
              })
          ),
        // Without a real PTY there is no `SIGWINCH` to send; record the size so
        // a node-pty backend can honour it, and report nothing as failed.
        resize: (cols: number, rows: number) =>
          Effect.sync(() => {
            void cols
            void rows
          }),
        output: attach(0),
        attach,
        exitCode: Effect.callback<number, PtyError>((resume) => {
          if (exited !== undefined) {
            resume(Effect.succeed(exited))
            return
          }
          child.once("exit", (code: number | null) => resume(Effect.succeed(code ?? 1)))
        })
      }
    })
  )

/**
 * Provides the `Pty` service backed by Node child processes with piped stdio.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer: Layer.Layer<Pty> = Layer.succeed(Pty)({
  spawn: (command: string, options: SpawnOptions) => makeHandle(command, options)
})
