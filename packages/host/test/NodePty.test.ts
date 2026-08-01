import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Stream from "effect/Stream"
import { describe, expect, it } from "vitest"
import * as NodePty from "../src/node/NodePty.ts"
import { Pty, type PtyHandle } from "../src/Pty.ts"

const decoder = new TextDecoder()

const withPty = <A, E>(
  command: string,
  f: (handle: PtyHandle) => Effect.Effect<A, E>,
  options: { cols: number; rows: number; cwd?: string; env?: Record<string, string> } = { cols: 80, rows: 24 }
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(Pty, (pty) => Effect.flatMap(pty.spawn(command, options), f))
    ).pipe(Effect.provide(NodePty.layer))
  )

const text = (chunks: Iterable<Uint8Array>): string => Array.from(chunks).map((chunk) => decoder.decode(chunk)).join("")

describe.skipIf(process.platform === "win32")("NodePty", () => {
  it("streams stdout and stderr through one output stream until the child exits", async () => {
    const output = await withPty(
      "echo hello; echo bad 1>&2",
      (handle) => Effect.map(Stream.runCollect(handle.output), text)
    )

    expect(output).toContain("hello\n")
    expect(output).toContain("bad\n")
  })

  it("exports the terminal size to the child as COLUMNS and LINES", async () => {
    const output = await withPty(
      "echo $COLUMNS:$LINES",
      (handle) => Effect.map(Stream.runCollect(handle.output), text),
      { cols: 132, rows: 43 }
    )

    expect(output.trim()).toBe("132:43")
  })

  it("resolves `exitCode` with the child's status, both before and after it exits", async () => {
    const codes = await withPty("exit 7", (handle) =>
      Effect.gen(function*() {
        const live = yield* handle.exitCode
        const afterExit = yield* handle.exitCode
        return [live, afterExit]
      }))

    expect(codes).toEqual([7, 7])
  })

  it("reports a signal-killed child as exit code 1", async () => {
    const code = await withPty("kill -KILL $$", (handle) => handle.exitCode)

    expect(code).toBe(1)
  })

  it("writes to the child's stdin while it is alive", async () => {
    const output = await withPty("head -n 1", (handle) =>
      Effect.gen(function*() {
        const collected = yield* Effect.forkChild(Stream.runCollect(handle.output), { startImmediately: true })
        yield* handle.write(new TextEncoder().encode("typed\n"))
        return text(yield* Fiber.join(collected))
      }))

    expect(output).toContain("typed\n")
  })

  it("fails a write with `exited` once the process is gone", async () => {
    const error = await withPty("exit 0", (handle) =>
      Effect.gen(function*() {
        yield* handle.exitCode
        return yield* Effect.flip(handle.write(new TextEncoder().encode("late")))
      }))

    expect(error).toMatchObject({ code: "exited", message: "Pty.write: process has exited" })
  })

  it("replays retained output from a cursor and ends an attach made after exit", async () => {
    const result = await withPty("echo alpha; echo beta", (handle) =>
      Effect.gen(function*() {
        const first = text(yield* Stream.runCollect(handle.output))
        const fromStart = text(yield* Stream.runCollect(handle.attach(0)))
        const midway = text(yield* Stream.runCollect(handle.attach(6)))
        return { first, fromStart, midway }
      }))

    expect(result.first).toBe("alpha\nbeta\n")
    expect(result.fromStart).toBe("alpha\nbeta\n")
    expect(result.midway).toBe("beta\n")
  })

  it("streams output that is written after the direct child exits, until the pipe itself closes", async () => {
    // The shell exits immediately while a background grandchild keeps the
    // stdout pipe open and writes later. Ending the stream on the child's
    // `exit` event drops that tail; the pipe closing is the real end of output.
    const result = await withPty("(sleep 0.05; echo late) & echo now", (handle) =>
      Effect.gen(function*() {
        const collected = yield* Effect.forkChild(Stream.runCollect(handle.output), { startImmediately: true })
        const code = yield* handle.exitCode
        return { code, output: text(yield* Fiber.join(collected)) }
      }))

    expect(result.code).toBe(0)
    expect(result.output).toContain("now\n")
    expect(result.output).toContain("late\n")
  })

  it("clamps an attach cursor beyond what was retained to the live end of the ring", async () => {
    const replayed = await withPty("echo short", (handle) =>
      Effect.gen(function*() {
        yield* handle.exitCode
        return text(yield* Stream.runCollect(handle.attach(1_000_000)))
      }))

    expect(replayed).toBe("")
  })

  it("bounds the replay ring, so a late attach resumes at the oldest retained byte", async () => {
    const result = await withPty("head -c 400000 /dev/zero | tr '\\0' 'a'", (handle) =>
      Effect.gen(function*() {
        const live = text(yield* Stream.runCollect(handle.output))
        const replayed = text(yield* Stream.runCollect(handle.attach(0)))
        return { live: live.length, replayed }
      }))

    expect(result.live).toBe(400_000)
    expect(result.replayed.length).toBeLessThan(400_000)
    expect(result.replayed.length).toBeGreaterThan(0)
    expect(new Set(result.replayed)).toEqual(new Set(["a"]))
  })

  it("records a resize without failing, since piped stdio has no SIGWINCH", async () => {
    const resized = await withPty("sleep 0.05", (handle) => Effect.as(handle.resize(120, 40), "ok"))

    expect(resized).toBe("ok")
  })

  it("kills a still-running child when the scope closes", async () => {
    let handle: PtyHandle | undefined
    await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(
          Pty,
          (pty) =>
            Effect.tap(pty.spawn("sleep 5", { cols: 80, rows: 24 }), (spawned) =>
              Effect.sync(() => {
                handle = spawned
              }))
        )
      ).pipe(Effect.provide(NodePty.layer))
    )

    const exitCode = await Effect.runPromise(handle!.exitCode)
    expect(exitCode).toBe(1)

    const error = await Effect.runPromise(Effect.flip(handle!.write(new TextEncoder().encode("x"))))
    expect(error).toMatchObject({ code: "exited", message: "Pty.write: process has exited" })
  })
})
