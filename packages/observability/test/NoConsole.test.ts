import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const PACKAGES_DIR = fileURLToPath(new URL("../..", import.meta.url))
const CONSOLE_CALL = /console\.(?:log|info|warn|error|debug|trace)\s*\(/

/**
 * Source files under every package's `src`. Walked in-process rather than
 * shelled out to ripgrep: a runner without `rg` makes `spawnSync` return
 * `status: null`, which fails this guard with "expected null to be 1" and
 * reads like a real console violation instead of a missing binary.
 */
function* sourceFiles(dir: string): Generator<string> {
  let entries: ReturnType<typeof readdirSync<{ withFileTypes: true }>>
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue
      yield* sourceFiles(path)
    } else if (/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
      yield path
    }
  }
}

function packageSourceRoots(): string[] {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(PACKAGES_DIR, entry.name, "src"))
}

describe("console guard", () => {
  it("finds no direct console calls in package source", () => {
    const offenders: string[] = []
    for (const root of packageSourceRoots()) {
      for (const file of sourceFiles(root)) {
        const source = readFileSync(file, "utf8")
        if (!CONSOLE_CALL.test(source)) continue
        for (const [index, line] of source.split("\n").entries()) {
          if (CONSOLE_CALL.test(line)) offenders.push(`${file.slice(PACKAGES_DIR.length)}:${index + 1}: ${line.trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it("scans a non-empty set of package sources", () => {
    const scanned = packageSourceRoots().flatMap((root) => Array.from(sourceFiles(root)))
    expect(scanned.length).toBeGreaterThan(0)
  })
})
