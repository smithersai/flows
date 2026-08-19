/**
 * A cache hit restores the bytes it promises.
 *
 * The action cache alone records that a target succeeded and what its declared
 * outputs digested to. That envelope cannot put a file back, so a hit on a
 * clean tree used to report `TsBuild` green while `dist` did not exist. These
 * cases pin the content-addressed store behind it: a green run publishes every
 * declared output under the digest capture already computed, a hit restores
 * every one of them before it is reported, a swept blob is a miss that
 * re-executes, and a target that declares no output never touches the store at
 * all.
 */
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Executor from "../src/Executor.ts"
import * as Planner from "../src/Planner.ts"
import { Workspace } from "../src/Workspace.ts"

const rulesModule = NodePath.resolve(import.meta.dirname, "../../targets/src/Smithers.ts")

let root: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

/**
 * A workspace with one cacheable `ToolBuild` target: `program` is the body of
 * a `node -e` run and `outputs` is what it declares it produces.
 */
const toolWorkspace = async (program: string, outputs: ReadonlyArray<string>): Promise<void> => {
  await write("package.json", `${JSON.stringify({ name: "fixture", private: true }, undefined, 2)}\n`)
  await write("src/input.txt", "source\n")
  await write(
    "BUILD.ts",
    `import { file, ToolBuild } from "${rulesModule}"\n` +
      `export const build = ToolBuild({\n` +
      `  tool: "node",\n` +
      `  command: "node",\n` +
      `  args: ["-e", ${JSON.stringify(program)}],\n` +
      `  inputs: [file("//src/input.txt")],\n` +
      `  outputs: ${JSON.stringify(outputs)},\n` +
      `  deps: [],\n` +
      `  env: {},\n` +
      `  cache: true,\n` +
      `  cwd: "."\n` +
      `})\n`
  )
}

/** Plans and executes `build` over the whole workspace, as the CLI does. */
const run = async (): Promise<Executor.Summary> => {
  const workspace = await Workspace.make(root, root, { cacheDirectory: ".flows" })
  const plan = await Planner.make(workspace, "build", "//...")
  return Executor.execute({
    workspace,
    verb: "build",
    pattern: "//...",
    targets: plan.targets,
    jobs: 2,
    readCache: true,
    log: () => {}
  })
}

/** Every blob the content-addressed store holds, by content address. */
const blobs = async (): Promise<ReadonlyArray<string>> => {
  const directory = NodePath.join(root, ".flows/objects")
  const shards = await Fs.readdir(directory, { withFileTypes: true }).catch(() => [])
  const found: Array<string> = []
  for (const shard of shards) {
    if (!shard.isDirectory()) continue
    for (const entry of await Fs.readdir(NodePath.join(directory, shard.name))) found.push(entry)
  }
  return found.sort()
}

const exists = (relative: string): Promise<boolean> =>
  Fs.stat(NodePath.join(root, relative)).then(() => true, () => false)

beforeEach(async () => {
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-artifacts-"))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("a cache hit restores declared outputs", () => {
  it("restores a deleted file output byte for byte", async () => {
    await toolWorkspace("require('node:fs').writeFileSync('out', 'produced\\n')", ["out"])

    const first = await run()
    expect(first.ok).toBe(true)
    expect(first.counts.ran).toBe(1)
    const produced = await Fs.readFile(NodePath.join(root, "out"))
    // Two blobs: the file's own bytes and the tree manifest addressed by the
    // content digest the success envelope records.
    expect(await blobs()).toHaveLength(2)

    await Fs.rm(NodePath.join(root, "out"))
    expect(await exists("out")).toBe(false)

    const second = await run()
    expect(second.ok).toBe(true)
    expect(second.counts.hit).toBe(1)
    expect(second.counts.ran).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "out"))).toEqual(produced)
  })

  it("stores the tree manifest under the content digest capture computed", async () => {
    await toolWorkspace("require('node:fs').writeFileSync('out', 'produced\\n')", ["out"])

    expect((await run()).ok).toBe(true)

    // The digest the envelope records is the address the manifest is filed
    // under, so `Input.Produced` and every later lookup share one digest
    // rather than needing a second index.
    const entries = await Fs.readdir(NodePath.join(root, ".flows/cache"), { recursive: true })
    const file = entries.find((entry) => entry.endsWith(".json"))!
    const stored = JSON.parse(await Fs.readFile(NodePath.join(root, ".flows/cache", file), "utf8"))
    const decoded = Executor.decodeCacheOutput(stored.output)
    if (!("value" in decoded)) throw new Error(decoded.reason)
    const digest =
      (decoded.value as { readonly outputs: ReadonlyArray<{ readonly contentDigest: string }> }).outputs[0]!
        .contentDigest
    expect(await blobs()).toContain(digest)
  })

  it("restores a directory output, nested files and empty directories alike", async () => {
    await toolWorkspace(
      "const fs = require('node:fs');" +
        "fs.mkdirSync('out/nested', { recursive: true });" +
        "fs.mkdirSync('out/empty', { recursive: true });" +
        "fs.writeFileSync('out/b.txt', 'b');" +
        "fs.writeFileSync('out/a.txt', 'a');" +
        "fs.writeFileSync('out/nested/c.txt', 'c');" +
        "fs.chmodSync('out/a.txt', 0o755)",
      ["out"]
    )

    expect((await run()).ok).toBe(true)
    await Fs.rm(NodePath.join(root, "out"), { recursive: true })

    const second = await run()
    expect(second.counts.hit).toBe(1)
    expect(second.counts.ran).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "out/a.txt"), "utf8")).toBe("a")
    expect(await Fs.readFile(NodePath.join(root, "out/b.txt"), "utf8")).toBe("b")
    expect(await Fs.readFile(NodePath.join(root, "out/nested/c.txt"), "utf8")).toBe("c")
    expect((await Fs.stat(NodePath.join(root, "out/empty"))).isDirectory()).toBe(true)
    // The executable bit is manifest content, so a restored tool stays a tool.
    expect((await Fs.stat(NodePath.join(root, "out/a.txt"))).mode & 0o111).not.toBe(0)
    expect((await Fs.stat(NodePath.join(root, "out/b.txt"))).mode & 0o111).toBe(0)
  })

  it("restores every declared output when a target declares more than one", async () => {
    await toolWorkspace(
      "const fs = require('node:fs');" +
        "fs.writeFileSync('first', 'one');" +
        "fs.mkdirSync('second', { recursive: true });" +
        "fs.writeFileSync('second/two.txt', 'two')",
      ["first", "second"]
    )

    expect((await run()).ok).toBe(true)
    await Fs.rm(NodePath.join(root, "first"))
    await Fs.rm(NodePath.join(root, "second"), { recursive: true })

    const second = await run()
    expect(second.counts.hit).toBe(1)
    expect(await Fs.readFile(NodePath.join(root, "first"), "utf8")).toBe("one")
    expect(await Fs.readFile(NodePath.join(root, "second/two.txt"), "utf8")).toBe("two")
  })

  it("replaces whatever a previous run left at the declared path", async () => {
    await toolWorkspace(
      "const fs = require('node:fs');" +
        "fs.mkdirSync('out', { recursive: true });" +
        "fs.writeFileSync('out/kept.txt', 'kept')",
      ["out"]
    )

    expect((await run()).ok).toBe(true)
    // A stray file inside the output makes the tree disagree with the
    // manifest. The restore removes the declared path first, so the hit is
    // earned by the recorded tree and not by a merge with the drift.
    await write("out/stray.txt", "stray")

    const second = await run()
    expect(second.counts.hit).toBe(1)
    expect(await exists("out/stray.txt")).toBe(false)
    expect(await Fs.readFile(NodePath.join(root, "out/kept.txt"), "utf8")).toBe("kept")
  })
})

describe("a missing blob is a miss", () => {
  it("re-executes when the blob behind a stored entry is gone", async () => {
    await toolWorkspace("require('node:fs').writeFileSync('out', 'produced\\n')", ["out"])

    expect((await run()).counts.ran).toBe(1)
    const stored = await blobs()
    expect(stored.length).toBe(2)

    // The action-cache entry survives; only the bytes are swept.
    await Fs.rm(NodePath.join(root, "out"))
    await Fs.rm(NodePath.join(root, ".flows/objects"), { recursive: true })
    expect(await exists(".flows/cache")).toBe(true)

    const second = await run()
    expect(second.ok).toBe(true)
    expect(second.counts.hit).toBe(0)
    expect(second.counts.ran).toBe(1)
    expect(await Fs.readFile(NodePath.join(root, "out"), "utf8")).toBe("produced\n")
    // The re-execution republishes what the sweep took.
    expect(await blobs()).toEqual(stored)
  })

  it("re-executes when only the file blob is gone and the manifest remains", async () => {
    await toolWorkspace("require('node:fs').writeFileSync('out', 'produced\\n')", ["out"])

    expect((await run()).counts.ran).toBe(1)
    const entries = await Fs.readdir(NodePath.join(root, ".flows/cache"), { recursive: true })
    const file = entries.find((entry) => entry.endsWith(".json"))!
    const stored = JSON.parse(await Fs.readFile(NodePath.join(root, ".flows/cache", file), "utf8"))
    const decoded = Executor.decodeCacheOutput(stored.output)
    if (!("value" in decoded)) throw new Error(decoded.reason)
    const tree = (decoded.value as { readonly outputs: ReadonlyArray<{ readonly contentDigest: string }> }).outputs[0]!
      .contentDigest
    const content = (await blobs()).find((digest) => digest !== tree)!

    await Fs.rm(NodePath.join(root, "out"))
    await Fs.rm(NodePath.join(root, `.flows/objects/${content.slice(0, 2)}/${content}`))

    // Every file address is probed before the declared path is touched, so a
    // manifest whose contents are gone never half-materializes a tree.
    const second = await run()
    expect(second.counts.hit).toBe(0)
    expect(second.counts.ran).toBe(1)
    expect(await Fs.readFile(NodePath.join(root, "out"), "utf8")).toBe("produced\n")
  })
})

describe("a target that declares no output needs no blob", () => {
  it("hits from the envelope alone and never opens the artifact store", async () => {
    // A pure check: the tool runs, the exit status is the whole result, and
    // there is nothing on disk for a hit to reproduce.
    await toolWorkspace("process.exit(0)", [])

    const first = await run()
    expect(first.ok).toBe(true)
    expect(first.counts.ran).toBe(1)
    expect(await exists(".flows/objects")).toBe(false)

    const second = await run()
    expect(second.ok).toBe(true)
    expect(second.counts.hit).toBe(1)
    expect(second.counts.ran).toBe(0)
    expect(await exists(".flows/objects")).toBe(false)
  })
})
