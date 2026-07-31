/**
 * Executes the `Bun.spawn` code paths under Node by driving `BunShell.make`
 * with a fake Bun runtime.
 *
 * `BunShell.layer` falls back to `NodeShell` off Bun by design, so the host
 * contract suite answers every assertion with the Node implementation and
 * covers none of this. These tests own the Bun surface: buffered and streaming
 * execution, stdin, timeout kill, spawn failure, and the interrupt finalizer.
 */
import { Effect, Fiber, Stream } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { BunRuntime, BunSubprocess } from "../src/bun/BunShell.ts"
import * as BunShell from "../src/bun/BunShell.ts"
import { ShellError } from "../src/HostError.ts"
import { Shell } from "../src/Shell.ts"

const encoder = new TextEncoder()

const readableOf = (chunks: ReadonlyArray<string>): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  })

const failingReadable = (): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("stream broke"))
    }
  })

interface FakeOptions {
  readonly stdout?: ReadableStream<Uint8Array> | undefined
  readonly stderr?: ReadableStream<Uint8Array> | undefined
  readonly exitCode?: number | undefined
  /** When set, `exited` only settles once `release` is called. */
  readonly hang?: boolean | undefined
}

interface Fake {
  readonly runtime: BunRuntime
  readonly subprocess: () => BunSubprocess
  readonly stdinWrites: Array<string>
  readonly stdinEnded: () => boolean
  readonly kills: () => ReadonlyArray<string | number | undefined>
  readonly spawnOptions: () => ReadonlyArray<unknown>
  readonly release: () => void
}

const fake = (options: FakeOptions = {}): Fake => {
  const stdinWrites: Array<string> = []
  const kills: Array<string | number | undefined> = []
  const spawnOptions: Array<unknown> = []
  let ended = false
  let killed = false
  let settle: (code: number) => void = () => {}
  let created: BunSubprocess | undefined
  const exitCode = options.exitCode ?? 0
  const exited = options.hang === true
    ? new Promise<number>((resolve) => {
      settle = resolve
    })
    : Promise.resolve(exitCode)
  const subprocess: BunSubprocess = {
    stdin: {
      write: (data) => {
        stdinWrites.push(typeof data === "string" ? data : new TextDecoder().decode(data))
        return 0
      },
      end: () => {
        ended = true
      }
    },
    stdout: options.stdout ?? readableOf([]),
    stderr: options.stderr ?? readableOf([]),
    exited,
    get killed() {
      return killed
    },
    kill: (signal) => {
      killed = true
      kills.push(signal)
      settle(exitCode)
    }
  }
  return {
    runtime: {
      spawn: (spawn) => {
        spawnOptions.push(spawn)
        created = subprocess
        return subprocess
      }
    },
    subprocess: () => created ?? subprocess,
    stdinWrites,
    stdinEnded: () => ended,
    kills: () => kills,
    spawnOptions: () => spawnOptions,
    release: () => settle(exitCode)
  }
}

const collect = (stream: Stream.Stream<{ readonly kind: string; readonly chunk: Uint8Array }, ShellError>) =>
  Stream.runCollect(stream).pipe(
    Effect.map((chunks) =>
      Array.from(chunks).map((chunk) => ({
        kind: chunk.kind,
        text: new TextDecoder().decode(chunk.chunk)
      }))
    )
  )

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("BunShell.make", () => {
  it("buffers stdout and stderr and reports the exit code", () =>
    Effect.runPromise(Effect.gen(function*() {
      const bun = fake({ stdout: readableOf(["out", "put"]), stderr: readableOf(["err"]), exitCode: 3 })
      const shell = BunShell.make(bun.runtime)
      const result = yield* shell.exec("echo hi", { cwd: "/tmp", env: { A: "b" }, stdin: "fed" })
      expect(result).toEqual({ stdout: "output", stderr: "err", exitCode: 3 })
      expect(bun.stdinWrites).toEqual(["fed"])
      expect(bun.stdinEnded()).toBe(true)
      expect(bun.spawnOptions()[0]).toMatchObject({ cwd: "/tmp", env: { A: "b" }, stdin: "pipe" })
    })))

  it("closes stdin without writing when none is supplied", () =>
    Effect.runPromise(Effect.gen(function*() {
      const bun = fake()
      const shell = BunShell.make(bun.runtime)
      yield* shell.exec("true")
      expect(bun.stdinWrites).toEqual([])
      expect(bun.stdinEnded()).toBe(true)
    })))

  it("fails with spawn_error when the runtime cannot spawn", () =>
    Effect.runPromise(Effect.gen(function*() {
      const shell = BunShell.make({
        spawn: () => {
          throw new Error("no such shell")
        }
      })
      const failure = yield* Effect.flip(shell.exec("boom"))
      expect(failure).toBeInstanceOf(ShellError)
      expect(failure.code).toBe("spawn_error")
      expect(failure.command).toBe("boom")
    })))

  it("kills the child and fails with timeout when the budget elapses", () =>
    Effect.runPromise(Effect.gen(function*() {
      const bun = fake({ hang: true })
      const shell = BunShell.make(bun.runtime)
      const failure = yield* Effect.flip(shell.exec("sleep 100", { timeoutMs: 5 }))
      expect(failure.code).toBe("timeout")
      expect(failure.message).toContain("5ms")
      expect(bun.kills()).toEqual(["SIGKILL"])
    })))

  it("kills the child when the fiber is interrupted", () =>
    Effect.runPromise(Effect.gen(function*() {
      const bun = fake({ hang: true })
      const shell = BunShell.make(bun.runtime)
      const fiber = yield* shell.exec("sleep 100").pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.sleep(5)
      yield* Fiber.interrupt(fiber)
      expect(bun.kills()).toEqual(["SIGKILL"])
    })))

  it("fails when reading the child's output rejects", () =>
    Effect.runPromise(Effect.gen(function*() {
      const bun = fake({ stdout: failingReadable() })
      const shell = BunShell.make(bun.runtime)
      const failure = yield* Effect.flip(shell.exec("cat"))
      expect(failure.code).toBe("spawn_error")
      expect(failure.message).toContain("stream broke")
    })))

  it("streams tagged chunks as the child produces them", () =>
    Effect.runPromise(Effect.gen(function*() {
      const bun = fake({ stdout: readableOf(["a", "b"]), stderr: readableOf(["e"]) })
      const shell = BunShell.make(bun.runtime)
      const chunks = yield* collect(shell.stream("emit", { stdin: "in" }))
      expect(chunks.filter((chunk) => chunk.kind === "stdout").map((chunk) => chunk.text)).toEqual(["a", "b"])
      expect(chunks.filter((chunk) => chunk.kind === "stderr").map((chunk) => chunk.text)).toEqual(["e"])
      expect(bun.stdinWrites).toEqual(["in"])
    })))

  it("fails the stream with timeout and kills the child", () =>
    Effect.runPromise(Effect.gen(function*() {
      const bun = fake({ hang: true })
      const shell = BunShell.make(bun.runtime)
      const failure = yield* Effect.flip(collect(shell.stream("sleep 100", { timeoutMs: 5 })))
      expect(failure.code).toBe("timeout")
      expect(bun.kills()).toEqual(["SIGKILL"])
    })))

  it("fails the stream when a reader rejects", () =>
    Effect.runPromise(Effect.gen(function*() {
      const bun = fake({ stdout: failingReadable() })
      const shell = BunShell.make(bun.runtime)
      const failure = yield* Effect.flip(collect(shell.stream("cat")))
      expect(failure.code).toBe("spawn_error")
    })))

  it("fails the stream with spawn_error when the runtime cannot spawn", () =>
    Effect.runPromise(Effect.gen(function*() {
      const shell = BunShell.make({
        spawn: () => {
          throw new Error("no such shell")
        }
      })
      const failure = yield* Effect.flip(collect(shell.stream("boom")))
      expect(failure.code).toBe("spawn_error")
    })))

  it("kills the child when the stream's scope closes early", () =>
    Effect.runPromise(Effect.gen(function*() {
      const bun = fake({ hang: true, stdout: readableOf(["a", "b", "c"]) })
      const shell = BunShell.make(bun.runtime)
      yield* Stream.runCollect(Stream.take(shell.stream("emit"), 1))
      expect(bun.kills()).toEqual(["SIGKILL"])
    })))
})

describe("BunShell.layer", () => {
  it("uses Bun.spawn when a Bun runtime is present", () =>
    Effect.runPromise(Effect.gen(function*() {
      const bun = fake({ stdout: readableOf(["bun"]) })
      vi.stubGlobal("Bun", { spawn: bun.runtime.spawn })
      yield* Effect.gen(function*() {
        const shell = yield* Shell
        const result = yield* shell.exec("echo bun")
        expect(result.stdout).toBe("bun")
      }).pipe(Effect.provide(BunShell.layer))
      expect(bun.spawnOptions()).toHaveLength(1)
    })))

  it("falls back to the Node implementation off Bun", () =>
    Effect.runPromise(Effect.gen(function*() {
      yield* Effect.gen(function*() {
        const shell = yield* Shell
        const result = yield* shell.exec("printf node")
        expect(result.stdout).toBe("node")
      }).pipe(Effect.provide(BunShell.layer))
    })))

  it("reports shell_unavailable when Bun exposes no spawn", () =>
    Effect.runPromise(Effect.gen(function*() {
      vi.stubGlobal("Bun", {})
      yield* Effect.gen(function*() {
        const shell = yield* Shell
        const failure = yield* Effect.flip(shell.exec("echo hi"))
        expect(failure.code).toBe("shell_unavailable")
      }).pipe(Effect.provide(BunShell.layer))
    })))
})
