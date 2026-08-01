/**
 * `NodeJj`'s error surface, driven against a stand-in `jj` on `PATH`.
 *
 * A real repository cannot produce every failure vocabulary on demand — jj
 * reports conflicts, missing revisions, and signal deaths under conditions a
 * test cannot reliably stage. The classification is the contract, so the binary
 * is scripted instead and the service is exercised end to end through it.
 */
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { existsSync } from "node:fs"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Jj } from "../src/Jj.ts"
import * as NodeJj from "../src/node/NodeJj.ts"

const script = `#!/bin/sh
case "$FLOWS_FAKE_JJ" in
  conflict) echo "Error: would leave conflicts in note.txt" 1>&2; exit 1 ;;
  revision-not-found) echo "Error: Revision not found" 1>&2; exit 1 ;;
  doesnt-exist) echo "Error: Path doesn't exist" 1>&2; exit 1 ;;
  stdout-only) echo "Error: reported on stdout"; exit 1 ;;
  signal) kill -9 $$ ;;
  slow) /bin/sleep 1; : > "$FLOWS_FAKE_JJ_MARKER" ;;
  orphan) (/bin/sleep 1; : > "$FLOWS_FAKE_JJ_MARKER") & exit 0 ;;
  *) exit 0 ;;
esac
`

const run = <A, E>(effect: Effect.Effect<A, E, Jj>) => Effect.runPromise(Effect.provide(effect, NodeJj.layer))

const status = (mode: string) => {
  process.env.FLOWS_FAKE_JJ = mode
  return run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.status())))
}

describe.skipIf(process.platform === "win32")("NodeJj failure classification", () => {
  let directory: string
  let previousPath: string | undefined

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "flows-fake-jj-"))
    await writeFile(join(directory, "jj"), script)
    await chmod(join(directory, "jj"), 0o755)

    previousPath = process.env.PATH
    process.env.PATH = directory
  })

  afterAll(async () => {
    process.env.PATH = previousPath
    delete process.env.FLOWS_FAKE_JJ
    delete process.env.FLOWS_FAKE_JJ_MARKER
    await rm(directory, { recursive: true, force: true })
  })

  it("classifies conflict vocabulary as `conflict`", async () => {
    const error = await status("conflict")

    expect(error.code).toBe("conflict")
    expect(error.message).toBe("jj status: Error: would leave conflicts in note.txt")
  })

  it("classifies `revision not found` as `invalid_ref`", async () => {
    expect((await status("revision-not-found")).code).toBe("invalid_ref")
  })

  it("classifies `doesn't exist` as `invalid_ref`", async () => {
    expect((await status("doesnt-exist")).code).toBe("invalid_ref")
  })

  it("falls back to stdout for the message when stderr is empty", async () => {
    const error = await status("stdout-only")

    expect(error.code).toBe("unknown")
    expect(error.message).toBe("jj status: Error: reported on stdout")
  })

  it("treats a signal-killed `jj` as a failure with no reported text", async () => {
    const error = await status("signal")

    expect(error.code).toBe("unknown")
    expect(error.message).toBe("jj status: ")
  })

  it("succeeds and returns stdout when the command exits zero", async () => {
    process.env.FLOWS_FAKE_JJ = "ok"

    await expect(run(Effect.flatMap(Jj, (jj) => jj.status()))).resolves.toBe("")
  })

  it("kills a still-running `jj` when the fiber is interrupted", async () => {
    const marker = join(directory, "escaped")
    process.env.FLOWS_FAKE_JJ = "slow"
    process.env.FLOWS_FAKE_JJ_MARKER = marker

    await Effect.runPromise(
      Effect.gen(function*() {
        const jj = yield* Jj
        const fiber = yield* Effect.forkChild(jj.status(), { startImmediately: true })
        yield* Effect.sleep(100)
        yield* Fiber.interrupt(fiber)
      }).pipe(Effect.provide(NodeJj.layer))
    )
    await Effect.runPromise(Effect.sleep(1_400))

    expect(existsSync(marker)).toBe(false)
  })

  it("does not signal a `jj` that already exited while its pipes are still held", async () => {
    const marker = join(directory, "orphan-finished")
    process.env.FLOWS_FAKE_JJ = "orphan"
    process.env.FLOWS_FAKE_JJ_MARKER = marker

    // `jj` exits immediately but a background descendant keeps stdout open, so
    // `close` never arrives and the call is still interruptible after the exit.
    await Effect.runPromise(
      Effect.gen(function*() {
        const jj = yield* Jj
        const fiber = yield* Effect.forkChild(jj.status(), { startImmediately: true })
        yield* Effect.sleep(300)
        yield* Fiber.interrupt(fiber)
      }).pipe(Effect.provide(NodeJj.layer))
    )
    await Effect.runPromise(Effect.sleep(1_200))

    // Nothing was signalled, so the descendant ran to completion.
    expect(existsSync(marker)).toBe(true)
  })
})

describe.skipIf(process.platform === "win32")("NodeJj spawn errors", () => {
  let directory: string
  let previousPath: string | undefined

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "flows-unexecutable-jj-"))
    await writeFile(join(directory, "jj"), script)
    await chmod(join(directory, "jj"), 0o644)
    previousPath = process.env.PATH
    process.env.PATH = directory
  })

  afterAll(async () => {
    process.env.PATH = previousPath
    await rm(directory, { recursive: true, force: true })
  })

  it("reports a non-ENOENT spawn failure as `unknown` rather than `not_installed`", async () => {
    const error = await run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.status())))

    expect(error.code).toBe("unknown")
    expect(error.message).toMatch(/^jj status: /)
  })
})
