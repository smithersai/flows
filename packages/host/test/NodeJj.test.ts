import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Jj } from "../src/Jj.ts"
import * as NodeJj from "../src/node/NodeJj.ts"

const jjInstalled = (() => {
  try {
    execFileSync("jj", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

// On CI the real-binary suite is the only thing exercising the actual jj
// contract — the scripted-fake suite already keeps coverage green — so a
// silent skip would let a behavioural regression against real jj merge
// unnoticed (issue #163). Locally the skip stays quiet; on CI it fails loud.
describe.runIf(Boolean(process.env.CI) && !jjInstalled)("NodeJj (CI guard)", () => {
  it("fails loudly when CI has no jj on PATH", () => {
    throw new Error(
      "jj is not installed on this CI runner, so the real-binary NodeJj suite "
        + "silently skipped. Install jj in .github/workflows/ci.yml (see the "
        + "'Install jj' step) — do not let this suite no-op on CI."
    )
  })
})

/**
 * `NodeJj` spawns `jj` in `process.cwd()`, so every case runs against a real
 * throwaway repository that this suite chdirs into.
 */
// Every operation waits for the spawned process to close; elapsed time is not
// part of the contract, and the package-wide `testTimeout` budgets for the
// jj-lock contention several of these suites create for each other.
describe.skipIf(!jjInstalled)("NodeJj", () => {
  let repository: string
  let previousCwd: string

  const run = <A, E>(effect: Effect.Effect<A, E, Jj>) => Effect.runPromise(Effect.provide(effect, NodeJj.layer))

  beforeAll(async () => {
    previousCwd = process.cwd()
    repository = await mkdtemp(join(tmpdir(), "flows-node-jj-"))
    execFileSync("jj", ["git", "init", repository], { stdio: "ignore" })
    // `jj describe` with no `-m` opens an editor; keep the non-interactive path.
    process.env.JJ_EDITOR = "true"
    process.chdir(repository)
  })

  afterAll(async () => {
    process.chdir(previousCwd)
    await rm(repository, { recursive: true, force: true })
  })

  it("snapshots the working copy and restores a file back out of it", async () => {
    const file = join(repository, "note.txt")
    await writeFile(file, "first\n")

    const { changeId } = await run(Effect.flatMap(Jj, (jj) => jj.snapshot("first commit")))
    expect(changeId).toMatch(/^[a-z]+$/)

    await writeFile(file, "second\n")
    await run(Effect.flatMap(Jj, (jj) => jj.snapshot("second commit")))

    const diff = await run(Effect.flatMap(Jj, (jj) => jj.diff(changeId, "@-")))
    expect(diff).toContain("note.txt")
    expect(diff).toContain("+second")

    const status = await run(Effect.flatMap(Jj, (jj) => jj.status()))
    expect(status).toContain("Working copy")
  })

  it("snapshots without a message when none is supplied", async () => {
    await writeFile(join(repository, "unnamed.txt"), "x\n")
    const { changeId } = await run(Effect.flatMap(Jj, (jj) => jj.snapshot()))

    expect(changeId).not.toBe("")
    const log = execFileSync("jj", ["log", "-r", changeId, "--no-graph", "-T", "change_id.short()"], {
      cwd: repository,
      encoding: "utf8"
    })
    expect(log.trim()).toBe(changeId)
  })

  it("adds and forgets a named workspace lane", async () => {
    const lane = join(repository, "..", `lane-${process.pid}`)
    await run(Effect.flatMap(Jj, (jj) => jj.workspaceAdd("lane", lane)))
    expect(existsSync(lane)).toBe(true)

    const workspaces = execFileSync("jj", ["workspace", "list"], { cwd: repository, encoding: "utf8" })
    expect(workspaces).toContain("lane")

    await run(Effect.flatMap(Jj, (jj) => jj.workspaceForget("lane")))
    expect(execFileSync("jj", ["workspace", "list"], { cwd: repository, encoding: "utf8" }))
      .not.toContain("lane:")
    await rm(lane, { recursive: true, force: true })
  })

  it("classifies an unknown revision as `invalid_ref`", async () => {
    const error = await run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.restore("nosuchchangeid"))))

    expect(error.code).toBe("invalid_ref")
    expect(error.message).toContain("jj restore")
  })

  it("classifies an unrecognized failure as `unknown`", async () => {
    const error = await run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.diff("@@@bad", "@"))))

    expect(error.code).toBe("unknown")
    expect(error.message).toContain("jj diff")
  })

  it("reports `not_installed` when `jj` is not on PATH", async () => {
    const path = process.env.PATH
    process.env.PATH = join(repository, "empty-bin")
    try {
      const error = await run(Effect.flip(Effect.flatMap(Jj, (jj) => jj.status())))
      expect(error.code).toBe("not_installed")
      expect(error.message).toBe("jj: command not found on PATH")
    } finally {
      process.env.PATH = path
    }
  })
})
