import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as GeneratedFile from "../src/GeneratedFile.ts"
import * as Target from "../src/Target.ts"
import * as Tsconfig from "../src/Tsconfig.ts"

let root: string

beforeEach(async () => {
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-generated-mode-"))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

/**
 * Lists every file below a directory with its contents, sorted by path, so
 * two trees compare byte-for-byte.
 */
const snapshot = async (directory: string): Promise<ReadonlyArray<readonly [string, string]>> => {
  const entries: Array<readonly [string, string]> = []
  const walk = async (relative: string): Promise<void> => {
    const listing = await Fs.readdir(NodePath.join(directory, relative), { withFileTypes: true })
    for (const entry of listing) {
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) await walk(child)
      else entries.push([child, await Fs.readFile(NodePath.join(directory, child), "utf8")])
    }
  }
  await walk("")
  return entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
}

describe("the shared mode vocabulary", () => {
  it("defaults to check", () => {
    const attrs = Schema.Struct({ mode: GeneratedFile.Mode }).make({})
    expect(attrs.mode).toBe("check")
  })

  it("accepts exactly write and check", () => {
    const decode = Schema.decodeUnknownSync(GeneratedFile.Mode)
    expect(decode("write")).toBe("write")
    expect(decode("check")).toBe("check")
    expect(() => decode("refresh")).toThrow()
  })
})

describe("a paired declaration", () => {
  const check = Tsconfig.Tsconfig({})
  const write = Tsconfig.TsconfigWrite({})
  const checkMetadata = Target.metadata(check)
  const writeMetadata = Target.metadata(write)

  it("yields two targets with distinct identities", () => {
    expect(Target.isTarget(check)).toBe(true)
    expect(Target.isTarget(write)).toBe(true)
    expect(check).not.toBe(write)
    expect(checkMetadata.target).toBe("TsconfigCheck")
    expect(writeMetadata.target).toBe("TsconfigWrite")
  })

  it("yields distinct labels from one export name", () => {
    const names = GeneratedFile.targetSuffixes.map(([, suffix]) => `tsconfig${suffix}`)
    expect(names).toEqual(["tsconfig", "tsconfigWrite"])
    expect(new Set(names).size).toBe(names.length)
  })

  it("gives the halves distinct kinds", () => {
    expect(checkMetadata.kinds).toEqual(["lint"])
    expect(writeMetadata.kinds).toEqual(["run"])
  })

  it("caches the check half and never the write half", () => {
    expect(checkMetadata.cacheable).toBe(true)
    expect(writeMetadata.cacheable).toBe(false)
  })

  it("declares the written file only on the write half", () => {
    expect(checkMetadata.outputs).toBeUndefined()
    expect(writeMetadata.outputs).toEqual({ cwd: ".", paths: ["tsconfig.json"] })
  })

  it("declares the checked-in file as an input of both halves", () => {
    const input = { _tag: "File", path: "//tsconfig.json" }
    expect(checkMetadata.inputs).toEqual([input])
    expect(writeMetadata.inputs).toEqual([input])
  })
})

describe("the check half", () => {
  it("never mutates the tree, even when the check fails", async () => {
    await Fs.mkdir(NodePath.join(root, "generated"))
    await Fs.writeFile(NodePath.join(root, "generated", "config.json"), "drifted\n", "utf8")
    const before = await snapshot(root)

    await expect(Effect.runPromise(
      GeneratedFile.checkGeneratedFile(root, { path: "generated/config.json", contents: "expected\n" })
    )).rejects.toThrow(/drifted/)

    expect(await snapshot(root)).toEqual(before)
  })

  it("reports a missing file without creating its parent", async () => {
    await expect(Effect.runPromise(
      GeneratedFile.checkGeneratedFile(root, { path: "generated/config.json", contents: "expected\n" })
    )).rejects.toThrow(/the generated file is missing/)

    expect(await Fs.readdir(root)).toEqual([])
  })
})

describe("the write half", () => {
  it("publishes the file and leaves no temporary behind", async () => {
    await Effect.runPromise(
      GeneratedFile.writeGeneratedFile(root, { path: "generated/config.json", contents: "{\"ok\":true}\n" })
    )

    expect(await Fs.readFile(NodePath.join(root, "generated", "config.json"), "utf8")).toBe("{\"ok\":true}\n")
    expect(await Fs.readdir(NodePath.join(root, "generated"))).toEqual(["config.json"])
    expect(await snapshot(root)).toEqual([["generated/config.json", "{\"ok\":true}\n"]])
  })

  it("leaves no temporary behind when the write fails", async () => {
    await expect(Effect.runPromise(
      GeneratedFile.writeGeneratedFile(root, { path: "config.json", contents: "bad\ud800text" })
    )).rejects.toThrow(/unpaired UTF-16 surrogate/)

    expect(await Fs.readdir(root)).toEqual([])
  })
})
