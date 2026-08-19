/**
 * Folder units: a directory inside a package is a buildable unit.
 *
 * Two forms share one label space. A folder with its own BUILD.ts is a
 * subpackage: it is addressable at arbitrary depth, and its boundary prunes
 * the parent's declared globs, which the index answers by deriving a
 * dependency edge from each pruned parent target to the unit's default
 * target. A folder without one can still synthesize targets when a
 * `PackageDefaults` declaration drops its marker (`marker: null`), which is
 * the zero-boilerplate form: the folder is addressable and stays inside the
 * parent's globs, because only a BUILD.ts creates a boundary.
 */
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as Target from "@smthrs/targets/Target"
import * as Planner from "../src/Planner.ts"
import { Workspace } from "../src/Workspace.ts"

// Discovery falls back to a filesystem walk when git cannot run at all, which
// is what `ENOENT` from the spawn means. Any other failure is reported rather
// than answered by the fallback, so the mock has to be this exact shape.
vi.mock("node:child_process", () => ({
  execFile: (
    _file: unknown,
    _args: unknown,
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ): void => callback(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }), "", "")
}))

let root: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const smithers = NodePath.resolve(import.meta.dirname, "../../targets/src/Smithers.ts")

/** A Typecheck construction, with `cwd` as a raw JavaScript expression. */
const typecheck = (srcs: string, cwd: string, tsconfig: string): string =>
  `Typecheck({
  srcs: [${srcs}],
  deps: [],
  tsconfig: file(${JSON.stringify(tsconfig)}),
  buildMode: false,
  incremental: false,
  cwd: ${cwd}
})`

/** The synthesized unit's one target: a Typecheck over the folder's own files. */
const unitTarget = typecheck(`glob("*.ts")`, "attrs.cwd", "//tsconfig.json")

/** The folder-unit declaration: no marker, one Typecheck per folder. */
const unitRule = `export const folderUnits = PackageDefaults({
  directories: "pkg/src/*",
  marker: null,
  macro: (attrs) => ({ lib: ${unitTarget} })
})
`

const plan = async (label: string): Promise<Planner.Plan> =>
  Planner.make(await Workspace.make(root, root), "build", label)

const declaredFiles = async (label: string): Promise<ReadonlyArray<string>> => {
  const result = await plan(label)
  const target = result.targets.find((entry) => entry.label === label)
  if (target === undefined) throw new Error(`${label} was not planned`)
  return target.declaredInputs.flatMap((input) => input.files.map((file) => file.path))
}

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-folder-units-")))
  await write("WORKSPACE.ts", "export {}\n")
  await write("tsconfig.json", "{}\n")
  await write("pkg/tsconfig.json", "{}\n")
  await write("pkg/src/a.ts", "export const a = 1\n")
  await write("pkg/src/internal/b.ts", "export const b = 2\n")
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("marker-less folder units", () => {
  beforeEach(async () => {
    await write(
      "BUILD.ts",
      `import { file, glob, PackageDefaults, Typecheck } from "${smithers}"
${unitRule}
`
    )
    await write(
      "pkg/BUILD.ts",
      `import { file, glob, Typecheck } from "${smithers}"

export const lib = ${typecheck(`glob("src/**/*.ts")`, `"pkg"`, "tsconfig.json")}
`
    )
  })

  it("synthesizes a marker-less directory that matches the declaration", async () => {
    const workspace = await Workspace.make(root, root)
    const targets = await workspace.packageTargets("pkg/src/internal")
    expect([...targets.keys()]).toEqual(["lib"])
    expect(workspace.synthesizedDirectories()).toContain("pkg/src/internal")
  })

  it("is addressable as an exact label and appears in a recursive pattern", async () => {
    const workspace = await Workspace.make(root, root)
    const exact = await workspace.targets("//pkg/src/internal:lib")
    expect(exact).toHaveLength(1)
    const everything = await workspace.targets("//...")
    const labels = await Promise.all(everything.map((target) => workspace.label(target)))
    expect(labels).toContain("//pkg:lib")
    expect(labels).toContain("//pkg/src/internal:lib")
  })

  it("does not prune the parent's globs, because only a BUILD.ts is a boundary", async () => {
    const files = await declaredFiles("//pkg:lib")
    expect(files).toContain("pkg/src/a.ts")
    expect(files).toContain("pkg/src/internal/b.ts")
  })
})

describe("additive synthesis", () => {
  beforeEach(async () => {
    await write("pkg/package.json", `{ "name": "pkg" }\n`)
    await write(
      "BUILD.ts",
      `import { file, glob, PackageDefaults, Typecheck } from "${smithers}"

export const packageDefaults = PackageDefaults({
  directories: "pkg",
  marker: "package.json",
  macro: (attrs) => ({
    lib: ${typecheck(`glob("src/**/*.ts")`, "attrs.cwd", "//tsconfig.json")}
  })
})
${unitRule}
`
    )
  })

  it("synthesizes the parent package and the folder unit from one directory tree", async () => {
    const workspace = await Workspace.make(root, root)
    expect([...(await workspace.packageTargets("pkg")).keys()]).toEqual(["lib"])
    expect([...(await workspace.packageTargets("pkg/src/internal")).keys()]).toEqual(["lib"])
  })

  it("keeps the unit's files in the parent's declared inputs", async () => {
    const files = await declaredFiles("//pkg:lib")
    expect(files).toContain("pkg/src/internal/b.ts")
  })
})

describe("folder units with a BUILD.ts", () => {
  beforeEach(async () => {
    await write(
      "pkg/BUILD.ts",
      `import { file, glob, Typecheck } from "${smithers}"

export const lib = ${typecheck(`glob("src/**/*.ts")`, `"pkg"`, "tsconfig.json")}
`
    )
    await write(
      "pkg/src/internal/BUILD.ts",
      `import { file, glob, Typecheck } from "${smithers}"

export const lib = ${typecheck(`glob("*.ts")`, `"pkg/src/internal"`, "//pkg/tsconfig.json")}
`
    )
  })

  it("derives the edge the pruning guard asks for, from the parent to the unit", async () => {
    const result = await plan("//pkg:lib")
    expect(result.edges).toContainEqual({ from: "//pkg/src/internal:lib", to: "//pkg:lib" })
    // The parent's own glob still stops at the boundary. The subtree is back
    // in the parent's key through the derived edge, whose inputs measure it.
    const parent = result.targets.find((target) => target.label === "//pkg:lib")!
    const parentFiles = parent.declaredInputs.flatMap((input) => input.files.map((file) => file.path))
    expect(parentFiles).toContain("pkg/src/a.ts")
    expect(parentFiles).not.toContain("pkg/src/internal/b.ts")
    const whole = result.targets.flatMap((target) => target.declaredInputs)
      .flatMap((input) => input.files.map((file) => file.path))
    expect(whole).toContain("pkg/src/internal/b.ts")
  })

  it("re-keys the unit when a unit file changes, without re-measuring the parent's inputs", async () => {
    const before = await plan("//pkg:lib")
    await write("pkg/src/internal/b.ts", "export const b = 3\n")
    const after = await plan("//pkg:lib")
    const unit = (result: Planner.Plan) => result.targets.find((target) => target.label === "//pkg/src/internal:lib")!
    const parent = (result: Planner.Plan) => result.targets.find((target) => target.label === "//pkg:lib")!
    expect(unit(after).keyPreview).not.toBe(unit(before).keyPreview)
    const parentInputs = (result: Planner.Plan) => parent(result).declaredInputs.map((input) => input.digest)
    expect(parentInputs(after)).toEqual(parentInputs(before))
  })
})

describe("synthesized unit manifests", () => {
  it("expands a manifest declaration whose scripts name the unit's own targets", async () => {
    await write(
      "BUILD.ts",
      `import { file, glob, PackageDefaults, PackageJson, Typecheck } from "${smithers}"

export const helper = ${typecheck(`file("tsconfig.json")`, `"."`, "tsconfig.json")}

export const folderUnits = PackageDefaults({
  directories: "pkg/src/*",
  marker: null,
  macro: (attrs) => {
    const lib = ${unitTarget}
    return {
      lib,
      packageJson: PackageJson({
        name: "@test/" + attrs.cwd.replaceAll("/", "-"),
        version: "0.1.0",
        scripts: { build: lib, setup: helper }
      })
    }
  }
})
`
    )
    const workspace = await Workspace.make(root, root)
    const targets = await workspace.packageTargets("pkg/src/internal")
    expect([...targets.keys()].sort()).toEqual([
      "lib",
      "packageJsonCheck",
      "packageJsonRefresh",
      "packageJsonWrite"
    ])
    const attrs = Target.metadata(targets.get("packageJsonCheck")!).attrs as {
      readonly fields: { readonly scripts: Record<string, string> }
    }
    // A synthesized manifest may name a target the index already registered —
    // here //:helper, loaded with the root BUILD.ts before synthesis ran.
    expect(attrs.fields.scripts).toEqual({
      build: "smthrs build //pkg/src/internal:lib",
      setup: "smthrs build //:helper"
    })
  })

  it("refuses a manifest naming a target no package has registered", async () => {
    await write(
      "BUILD.ts",
      `import { file, glob, PackageDefaults, PackageJson, Typecheck } from "${smithers}"

export const folderUnits = PackageDefaults({
  directories: "pkg/src/*",
  marker: null,
  macro: (attrs) => {
    const lib = ${unitTarget}
    const ghost = ${unitTarget}
    return {
      lib,
      packageJson: PackageJson({
        name: "@test/ghost",
        version: "0.1.0",
        scripts: { build: ghost }
      })
    }
  }
})
`
    )
    const workspace = await Workspace.make(root, root)
    await expect(workspace.packageTargets("pkg/src/internal")).rejects.toThrow(/naming a target with no label/)
  })
})
