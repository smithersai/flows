import { afterEach, describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listWorkspacePackages, makeConfinementValidator, runProcess } from "./harness.ts"

const temporaryRoots: string[] = []
afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop()!, { recursive: true, force: true })
})

describe("factory harness guards", () => {
  test("workspace package identities are read from exact manifests", () => {
    const packages = listWorkspacePackages()
    expect(packages.length).toBeGreaterThan(0)
    for (const pkg of packages) expect(pkg.npmName).toBe(`@smthrs/${pkg.dir}`)
  })

  test("structured arguments are never interpreted by a shell", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-args-"))
    temporaryRoots.push(root)
    const injected = join(root, "injected")
    const result = await Effect.runPromise(
      runProcess({
        id: "structured",
        command: "printf",
        args: [`$(touch ${injected})`],
        cwd: root,
        timeoutMs: 10_000,
        logDir: root
      })
    )
    expect(result.exitCode).toBe(0)
    expect(existsSync(injected)).toBe(false)
  })

  test("successful agents still require a machine-readable completion marker", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-marker-"))
    temporaryRoots.push(root)
    const result = await Effect.runPromise(
      runProcess({
        id: "marker",
        command: "printf",
        args: ["finished without receipt"],
        cwd: root,
        timeoutMs: 10_000,
        logDir: root,
        completionMarker: "DONE"
      })
    )
    expect(result.exitCode).toBe(-2)
  })

  test("post-run confinement rejects writes outside declared roots", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-confinement-"))
    temporaryRoots.push(root)
    execFileSync("git", ["init", "-q", root])
    execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"])
    execFileSync("git", ["-C", root, "config", "user.name", "Test"])
    mkdirSync(join(root, "allowed"))
    writeFileSync(join(root, "tracked.txt"), "base")
    execFileSync("git", ["-C", root, "add", "tracked.txt"])
    execFileSync("git", ["-C", root, "commit", "-qm", "base"])
    const validate = makeConfinementValidator(root, [join(root, "allowed")])
    writeFileSync(join(root, "outside.txt"), "escaped")
    expect(validate()).toContain("outside.txt")
  })
})
