import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as NodeShell from "../src/node/NodeShell.ts"
import { Shell } from "../src/Shell.ts"

const decoder = new TextDecoder()

const run = <A, E>(effect: Effect.Effect<A, E, Shell>) => Effect.runPromise(Effect.provide(effect, NodeShell.layer))

const withShell = <A, E>(f: (shell: Shell) => Effect.Effect<A, E>) => run(Effect.flatMap(Shell, f))

describe.skipIf(process.platform === "win32")("NodeShell exec", () => {
  let directory: string

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "flows-node-shell-behavior-"))
  })
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it("captures stdout, stderr, and a zero exit code", async () => {
    const result = await withShell((shell) => shell.exec("echo out; echo err 1>&2"))

    expect(result).toEqual({ stdout: "out\n", stderr: "err\n", exitCode: 0 })
  })

  it("reports a non-zero exit code without failing the effect", async () => {
    const result = await withShell((shell) => shell.exec("exit 42"))

    expect(result.exitCode).toBe(42)
  })

  it("reports the shell's 127 for a command that does not exist", async () => {
    const result = await withShell((shell) => shell.exec("flows-definitely-not-a-binary"))

    expect(result.exitCode).toBe(127)
    expect(result.stderr).toMatch(/not found/)
  })

  it("surfaces a signal-terminated child as exit code 1", async () => {
    const result = await withShell((shell) => shell.exec("kill -TERM $$"))

    expect(result.exitCode).toBe(1)
  })

  it("writes stdin and closes it so the child sees EOF", async () => {
    const result = await withShell((shell) => shell.exec("cat", { stdin: "piped input" }))

    expect(result.stdout).toBe("piped input")
  })

  it("closes stdin even when no input is supplied", async () => {
    const result = await withShell((shell) => shell.exec("cat"))

    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 })
  })

  it("runs in the requested cwd with the requested environment", async () => {
    const result = await withShell((shell) =>
      shell.exec("pwd; echo $FLOWS_MARKER", {
        cwd: directory,
        env: { PATH: process.env.PATH ?? "", FLOWS_MARKER: "marked" }
      })
    )

    expect(result.stdout.trimEnd().split("\n").at(-1)).toBe("marked")
    expect(result.stdout).toContain("flows-node-shell-behavior-")
  })

  it("fails with `shell_unavailable` when the working directory does not exist", async () => {
    const error = await withShell((shell) => Effect.flip(shell.exec("true", { cwd: join(directory, "absent") })))

    expect(error).toMatchObject({ code: "shell_unavailable" })
    expect(error.message).toMatch(/^Shell\.exec: /)
  })

  it("fails with `timeout` and kills the child once the budget elapses", async () => {
    const marker = join(directory, "timeout-escapee")

    const error = await withShell((shell) =>
      Effect.flip(shell.exec(`sleep 0.4; echo x > ${JSON.stringify(marker)}`, { timeoutMs: 25 }))
    )
    await Effect.runPromise(Effect.sleep(600))

    expect(error).toMatchObject({ code: "timeout" })
    expect(error.message).toBe("Shell.exec: `sleep 0.4; echo x > " + JSON.stringify(marker) + "` exceeded 25ms")
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("returns normally when the command finishes inside its budget", async () => {
    const result = await withShell((shell) => shell.exec("echo fast", { timeoutMs: 5_000 }))

    expect(result.stdout).toBe("fast\n")
  })
})

describe.skipIf(process.platform === "win32")("NodeShell stream", () => {
  it("tags stdout and stderr chunks separately", async () => {
    const chunks = await withShell((shell) =>
      Stream.runCollect(shell.stream("echo one; echo two 1>&2")).pipe(
        Effect.map((collected) =>
          Array.from(collected).map((chunk) => ({ kind: chunk.kind, text: decoder.decode(chunk.chunk) }))
        )
      )
    )

    expect(chunks.filter((chunk) => chunk.kind === "stdout").map((chunk) => chunk.text).join("")).toBe("one\n")
    expect(chunks.filter((chunk) => chunk.kind === "stderr").map((chunk) => chunk.text).join("")).toBe("two\n")
  })

  it("ends the stream when the child closes rather than failing", async () => {
    const chunks = await withShell((shell) => Stream.runCollect(shell.stream("exit 3")))

    expect(Array.from(chunks)).toEqual([])
  })

  it("feeds stdin to a streamed command", async () => {
    const text = await withShell((shell) =>
      Stream.runCollect(shell.stream("cat", { stdin: "streamed" })).pipe(
        Effect.map((chunks) => Array.from(chunks).map((chunk) => decoder.decode(chunk.chunk)).join(""))
      )
    )

    expect(text).toBe("streamed")
  })

  it("fails the stream with `shell_unavailable` when the working directory does not exist", async () => {
    const error = await withShell((shell) =>
      Effect.flip(Stream.runCollect(shell.stream("true", { cwd: "/flows/definitely/absent" })))
    )

    expect(error).toMatchObject({ code: "shell_unavailable" })
    expect(error.message).toMatch(/^Shell\.execStream: /)
  })
})
