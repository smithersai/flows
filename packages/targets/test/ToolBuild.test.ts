/**
 * Output measurement, the shared step every producing build target ends with.
 *
 * The end-to-end cases live in `cli/test/ToolBuild.test.ts`. These pin the
 * containment decisions directly, because a link planted below a declared
 * output, or an ancestor that is itself a link, is awkward to arrange through
 * a whole build and is exactly what must not be followed.
 */
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Target from "../src/Target.ts"
import { measureOutput, measureOutputs, OutputError, readOutputManifest, verifyOutputs } from "../src/ToolBuild.ts"

let root: string
let outside: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

beforeEach(async () => {
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-outputs-"))
  outside = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-outside-"))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
  await Fs.rm(outside, { recursive: true, force: true })
})

describe("measureOutput", () => {
  it("digests a plain file", async () => {
    await write("out/artifact.txt", "built")
    expect(await measureOutput(root, ".", "out/artifact.txt")).toMatchObject({
      path: "out/artifact.txt",
      fileCount: 1
    })
  })

  it("digests a directory in sorted order, whatever the creation order", async () => {
    await write("first/b.txt", "b")
    await write("first/nested/c.txt", "c")
    await write("first/a.txt", "a")
    await write("second/a.txt", "a")
    await write("second/b.txt", "b")
    await write("second/nested/c.txt", "c")

    const first = await measureOutput(root, ".", "first")
    const second = await measureOutput(root, ".", "second")

    expect(first.fileCount).toBe(3)
    expect(first.contentDigest).toBe(second.contentDigest)
  })

  /**
   * The regression: entries sorted with `localeCompare`, whose answer depends
   * on the host locale and ICU version. In an English locale `a.txt` sorts
   * before `Z.txt`, by code unit `Z.txt` (0x5A) sorts before `a.txt` (0x61),
   * and other locales order differently again, so one tree digested to
   * different values on different machines. The digest is pinned to the
   * code-unit order here.
   */
  it("digests in code-unit order, independent of the host locale", async () => {
    const { createHash } = await import("node:crypto")
    const sha = (value: string): string => createHash("sha256").update(value).digest("hex")
    await write("out/a.txt", "lower")
    await write("out/Z.txt", "upper")

    const measured = await measureOutput(root, ".", "out")

    const pairs = [
      ["file", "Z.txt", false, sha("upper")],
      ["file", "a.txt", false, sha("lower")]
    ]
    expect(measured.contentDigest).toBe(sha(JSON.stringify(pairs)))
  })

  it("accepts an empty directory", async () => {
    await Fs.mkdir(NodePath.join(root, "out"), { recursive: true })
    expect(await measureOutput(root, ".", "out")).toMatchObject({ path: "out", fileCount: 0 })
  })

  it("resolves the declared path against cwd", async () => {
    await write("packages/alpha/dist/index.js", "export {}")
    expect(await measureOutput(root, "packages/alpha", "dist")).toMatchObject({ path: "dist", fileCount: 1 })
  })

  it("fails when the output was not created", async () => {
    await expect(measureOutput(root, ".", "out")).rejects.toBeInstanceOf(OutputError)
    await expect(measureOutput(root, ".", "out")).rejects.toMatchObject({
      path: "out",
      message: "declared output was not created: out"
    })
  })

  it("fails when the declared path leaves the workspace", async () => {
    await Fs.writeFile(NodePath.join(outside, "secret.txt"), "not ours", "utf8")
    // Refused either as a lexical escape from the declaring directory or as an
    // escape from the workspace; both are the same verdict for the same path.
    await expect(measureOutput(root, ".", `../${NodePath.basename(outside)}/secret.txt`))
      .rejects.toMatchObject({ message: expect.stringMatching(/leaves the (workspace|directory)/) })
    await expect(measureOutput(root, ".", NodePath.join(outside, "secret.txt")))
      .rejects.toMatchObject({ message: expect.stringMatching(/leaves the workspace|is absolute/) })
  })

  it("fails on a symbolic link below a declared directory instead of following it", async () => {
    await Fs.writeFile(NodePath.join(outside, "secret.txt"), "not ours", "utf8")
    await Fs.mkdir(NodePath.join(root, "out"), { recursive: true })
    await Fs.symlink(NodePath.join(outside, "secret.txt"), NodePath.join(root, "out/linked.txt"))

    await expect(measureOutput(root, ".", "out")).rejects.toMatchObject({
      path: "out",
      message: expect.stringContaining("contains a symbolic link")
    })
  })

  it("fails when the declared path resolves outside through a linked ancestor", async () => {
    await Fs.mkdir(NodePath.join(outside, "escaped"), { recursive: true })
    await Fs.writeFile(NodePath.join(outside, "escaped/artifact.txt"), "not ours", "utf8")
    // `out` looks like an in-workspace directory and is not itself the declared
    // output; the declared output is a real file below it, in another tree.
    await Fs.symlink(NodePath.join(outside, "escaped"), NodePath.join(root, "out"))

    await expect(measureOutput(root, ".", "out/artifact.txt")).rejects.toMatchObject({
      message: expect.stringContaining("resolves outside the workspace")
    })
  })

  it("fails when the output is neither a file nor a directory", async () => {
    const { execFile } = await import("node:child_process")
    await new Promise<void>((resolve, reject) => {
      execFile("mkfifo", [NodePath.join(root, "out")], (error) => error === null ? resolve() : reject(error))
    })

    await expect(measureOutput(root, ".", "out")).rejects.toMatchObject({
      message: "declared output is not a file or a directory: out"
    })
  })
})

describe("measureOutputs", () => {
  it("measures every declared output in declaration order", async () => {
    await write("one.txt", "1")
    await write("two/inner.txt", "2")

    expect((await measureOutputs(root, ".", ["two", "one.txt"])).outputs.map((entry) => entry.path))
      .toEqual(["two", "one.txt"])
  })

  it("fails the whole capture when any one output is missing", async () => {
    await write("one.txt", "1")

    await expect(measureOutputs(root, ".", ["one.txt", "missing"])).rejects.toMatchObject({
      path: "missing"
    })
  })
})

/**
 * The manifest contract, checked directly.
 *
 * A manifest arrives either from a target implementation's success payload or
 * from a cache entry that another machine, a shared store, or a hand edit
 * wrote. Neither is trusted, and the declaration it is checked against always
 * comes from target metadata rather than from the value being checked.
 */
describe("readOutputManifest", () => {
  const declared: Target.DeclaredOutputs = { cwd: ".", paths: ["dist", "types"] }
  const entry = (path: string): Record<string, unknown> => ({
    path,
    fileCount: 1,
    contentDigest: "a".repeat(64)
  })

  it("accepts an exact, ordered manifest", () => {
    const outputs = [entry("dist"), entry("types")]
    expect(readOutputManifest(declared, { outputs })).toEqual({ outputs })
  })

  it.each([
    ["no manifest at all", { ok: true }],
    ["a null value", null],
    ["a manifest that is not a list", { outputs: "dist" }],
    ["an omitted output", { outputs: [entry("dist")] }],
    ["an extra output", { outputs: [entry("dist"), entry("types"), entry("extra")] }],
    ["a reordered manifest", { outputs: [entry("types"), entry("dist")] }],
    ["a duplicated output", { outputs: [entry("dist"), entry("dist")] }],
    ["a forged path", { outputs: [entry("dist"), entry("../../etc")] }],
    ["a bare string entry", { outputs: ["dist", "types"] }],
    ["a fractional file count", { outputs: [{ ...entry("dist"), fileCount: 0.5 }, entry("types")] }],
    ["a negative file count", { outputs: [{ ...entry("dist"), fileCount: -1 }, entry("types")] }],
    ["a non-finite file count", { outputs: [{ ...entry("dist"), fileCount: Number.NaN }, entry("types")] }],
    ["a file count that is a string", { outputs: [{ ...entry("dist"), fileCount: "1" }, entry("types")] }],
    ["a short digest", { outputs: [{ ...entry("dist"), contentDigest: "abc" }, entry("types")] }],
    ["an uppercase digest", { outputs: [{ ...entry("dist"), contentDigest: "A".repeat(64) }, entry("types")] }]
  ])("refuses %s", (_name, value) => {
    expect(typeof readOutputManifest(declared, value)).toBe("string")
  })

  it("accepts an empty manifest for a target that declares no paths", () => {
    expect(readOutputManifest({ cwd: ".", paths: [] }, { outputs: [] })).toEqual({ outputs: [] })
  })

  it("accepts a void success for a target that declares no paths", () => {
    // A generator in check mode writes nothing and declares nothing, so its
    // success value is void; there is no tree to verify a manifest against.
    expect(readOutputManifest({ cwd: ".", paths: [] }, undefined)).toEqual({ outputs: [] })
  })

  it("refuses a fabricated result for a target that declares no paths", () => {
    expect(typeof readOutputManifest({ cwd: ".", paths: [] }, { ok: true })).toBe("string")
  })

  it("refuses accessor, sparse, extra, symbol, and proxy shapes without invoking accessors", () => {
    let invocations = 0
    const accessor = {}
    Object.defineProperty(accessor, "outputs", {
      get: () => {
        invocations += 1
        return []
      },
      enumerable: true
    })
    const sparse = [entry("dist"), entry("types")]
    delete sparse[0]
    Object.assign(sparse, { extra: entry("dist") })
    const symbol = { outputs: [entry("dist"), entry("types")], [Symbol("extra")]: true }
    const extra = { outputs: [entry("dist"), entry("types")], extra: true }
    const proxy = new Proxy({ outputs: [entry("dist"), entry("types")] }, {
      ownKeys: (target) => {
        invocations += 1
        return Reflect.ownKeys(target)
      }
    })

    for (const value of [accessor, { outputs: sparse }, symbol, extra, proxy]) {
      expect(readOutputManifest(declared, value)).toBeTypeOf("string")
    }
    expect(invocations).toBe(0)
  })

  it("refuses negative zero as a file count", () => {
    expect(readOutputManifest(declared, {
      outputs: [{ ...entry("dist"), fileCount: -0 }, entry("types")]
    })).toBeTypeOf("string")
  })
})

describe("verifyOutputs", () => {
  it("agrees with a manifest the tree still satisfies", async () => {
    await write("dist/a.txt", "a")
    const declared: Target.DeclaredOutputs = { cwd: ".", paths: ["dist"] }
    const measured = await measureOutputs(root, ".", ["dist"])

    expect(await verifyOutputs(root, declared, measured)).toBeUndefined()
  })

  it("reports a manifest whose tree changed underneath it", async () => {
    await write("dist/a.txt", "a")
    const declared: Target.DeclaredOutputs = { cwd: ".", paths: ["dist"] }
    const measured = await measureOutputs(root, ".", ["dist"])
    await write("dist/a.txt", "edited")

    expect(await verifyOutputs(root, declared, measured)).toMatch(/no longer matches/)
  })

  it("reports a declared output that was never produced", async () => {
    expect(
      await verifyOutputs(root, { cwd: ".", paths: ["dist"] }, {
        outputs: [{ path: "dist", fileCount: 0, contentDigest: "a".repeat(64) }]
      })
    ).toMatch(/could not be measured/)
  })
})

describe("Target.declaredOutputs", () => {
  it("refuses a declaration naming one path twice", () => {
    // The manifest contract is an exact positional match and refuses
    // duplicates, so a target declaring one twice could never be satisfied.
    // Reporting it where it is declared beats failing at every execution.
    expect(() => Target.declaredOutputs("Example", { cwd: ".", paths: ["dist", "dist"] }))
      .toThrow(/Example declared outputs it cannot produce/)
  })

  it.each([
    ["an empty cwd", { cwd: "", paths: ["dist"] }],
    ["an empty path", { cwd: ".", paths: [""] }]
  ])("refuses %s", (_name, value) => {
    expect(() => Target.declaredOutputs("Example", value)).toThrow()
  })
})
