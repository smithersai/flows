import { readdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const sourceRoot = resolve(import.meta.dirname, "../src")

const sourceFiles = async (directory: string): Promise<Array<string>> => {
  const entries = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : []
  }))).flat()
}

describe("source purity", () => {
  it("does not import Node or another flows package", async () => {
    for (const file of await sourceFiles(sourceRoot)) {
      const source = await readFile(file, "utf8")
      expect(source).not.toMatch(/from\s+["']node:/)
      expect(source).not.toMatch(/from\s+["']@flows\//)
    }
  })
})
