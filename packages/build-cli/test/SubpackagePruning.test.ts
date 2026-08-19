/**
 * A nested BUILD.ts must never shrink a parent's declared inputs in silence.
 *
 * Glob expansion is package scoped by design: `Input.walk` refuses to descend
 * into a directory holding a BUILD.ts, and `Input.expandGlob` refuses a static
 * prefix that reaches past one. The tool the parent runs has no such rule. A
 * `tsc -b` over a package still compiles a subtree a new folder unit carved out
 * of it, so the declared inputs stop covering files the action reads and the
 * key stops changing when they change. Under `cache: true` that is a stale
 * green, which is why the guard has to land before the cache default flips.
 *
 * These cases reproduce the scratch-workspace finding exactly: two source
 * files, one nested BUILD.ts, and a diff of the declared input set.
 */
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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

/** The parent package, optionally depending on its nested unit. */
const parentBuild = (
  options: { readonly dependsOnInternal?: boolean; readonly extraSrcs?: string } = {}
): string =>
  `import { file, glob, Typecheck } from "${smithers}"
${options.dependsOnInternal ? `import { lib as internal } from "./src/internal/BUILD.ts"` : ""}

export const lib = Typecheck({
  srcs: [glob("src/**/*.ts")${options.extraSrcs ?? ""}],
  deps: [${options.dependsOnInternal ? "internal" : ""}],
  tsconfig: file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd: "pkg"
})
`

const internalBuild = `import { file, glob, Typecheck } from "${smithers}"

export const lib = Typecheck({
  srcs: [glob("*.ts")],
  deps: [],
  tsconfig: file("//pkg/tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd: "pkg/src/internal"
})
`

/** Every file the named target declares, across all of its declarations. */
const declaredFiles = async (verb: Planner.Plan["verb"], label: string): Promise<ReadonlyArray<string>> => {
  const workspace = await Workspace.make(root, root)
  const plan = await Planner.make(workspace, verb, label)
  const target = plan.targets.find((entry) => entry.label === label)
  if (target === undefined) throw new Error(`${label} was not planned`)
  return target.declaredInputs.flatMap((input) => input.files.map((file) => file.path))
}

const plan = async (label: string): Promise<Planner.Plan> => {
  const workspace = await Workspace.make(root, root)
  return Planner.make(workspace, "build", label)
}

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-cli-pruning-")))
  await write("WORKSPACE.ts", "export {}\n")
  await write("pkg/BUILD.ts", parentBuild())
  await write("pkg/tsconfig.json", "{}\n")
  await write("pkg/src/a.ts", "export const a = 1\n")
  await write("pkg/src/internal/b.ts", "export const b = 2\n")
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("subpackage pruning", () => {
  it("declares every file under the package while no nested BUILD.ts exists", async () => {
    const files = await declaredFiles("build", "//pkg:lib")
    expect(files).toContain("pkg/src/a.ts")
    expect(files).toContain("pkg/src/internal/b.ts")
  })

  it("refuses the plan when a nested BUILD.ts prunes a declared glob", async () => {
    await write("pkg/src/internal/BUILD.ts", internalBuild)
    // Before this guard the plan succeeded and quietly dropped
    // `pkg/src/internal/b.ts`, while `tsc` kept compiling it.
    await expect(plan("//pkg:lib")).rejects.toThrow(Planner.SubpackagePruningError)
  })

  it("names the target, the subpackage, and the files the boundary removed", async () => {
    await write("pkg/src/internal/BUILD.ts", internalBuild)
    await expect(plan("//pkg:lib")).rejects.toThrow(/\/\/pkg:lib declares the glob "src\/\*\*\/\*\.ts"/)
    await expect(plan("//pkg:lib")).rejects.toThrow(/BUILD\.ts file in \/\/pkg\/src\/internal/)
    await expect(plan("//pkg:lib")).rejects.toThrow(/pkg\/src\/internal\/b\.ts/)
  })

  it("plans again once the parent depends on a target in the subpackage", async () => {
    await write("pkg/src/internal/BUILD.ts", internalBuild)
    await write("pkg/BUILD.ts", parentBuild({ dependsOnInternal: true }))
    const files = await declaredFiles("build", "//pkg:lib")
    // The parent's own glob still stops at the boundary. The subtree is back in
    // the parent's key through the dependency, whose own inputs measure it.
    expect(files).toContain("pkg/src/a.ts")
    expect(files).not.toContain("pkg/src/internal/b.ts")
    const whole = (await plan("//pkg:lib")).targets
      .flatMap((target) => target.declaredInputs)
      .flatMap((input) => input.files.map((file) => file.path))
    expect(whole).toContain("pkg/src/a.ts")
    expect(whole).toContain("pkg/src/internal/b.ts")
  })

  it("accepts a rooted file declaration as coverage", async () => {
    await write("pkg/src/internal/BUILD.ts", internalBuild)
    await write("pkg/BUILD.ts", parentBuild({ extraSrcs: `, file("//pkg/src/internal/b.ts")` }))
    const files = await declaredFiles("build", "//pkg:lib")
    expect(files).toContain("pkg/src/internal/b.ts")
  })

  it("ignores a subpackage whose only pruned file is its own marker", async () => {
    await write("pkg/src/empty/BUILD.ts", internalBuild.replace("pkg/src/internal", "pkg/src/empty"))
    const files = await declaredFiles("build", "//pkg:lib")
    expect(files).toContain("pkg/src/a.ts")
  })

  it("still answers query on a workspace the build verb refuses", async () => {
    await write("pkg/src/internal/BUILD.ts", internalBuild)
    // A reader needs the labels to declare the missing edge. Refusing the
    // informational verbs would hide them.
    const workspace = await Workspace.make(root, root)
    const answered = await Planner.make(workspace, "query", "//...")
    expect(answered.roots).toContain("//pkg/src/internal:lib")
  })
})

/**
 * `synthesizeDirectory` applies the first eligible declaration. "First" has to
 * come from what a workspace declares, not from which BUILD.ts an invocation
 * happened to import: `//x` loads one build file and `//...` loads them all,
 * and the two would otherwise hand one directory its declarations in different
 * orders. Both declarations below match `units/one`, so the winner is
 * observable.
 */
describe("default-rule ordering", () => {
  const defaults = (name: string) =>
    `import { glob, PackageDefaults, Typecheck, file } from "${smithers}"

export const ${name} = PackageDefaults({
  directories: "//units/*",
  marker: "package.json",
  macro: (attrs: { readonly cwd: string }) => ({
    ${name}: Typecheck({
      srcs: [glob("*.ts")],
      deps: [],
      tsconfig: file("//tsconfig.json"),
      buildMode: false,
      incremental: false,
      cwd: attrs.cwd
    })
  })
})
`

  beforeEach(async () => {
    await write("BUILD.ts", defaults("rootRule"))
    await write("later/BUILD.ts", defaults("laterRule"))
    await write("tsconfig.json", "{}\n")
    await write("units/one/package.json", `{ "name": "one" }\n`)
    await write("units/one/x.ts", "export const x = 1\n")
  })

  it("applies the same declaration whichever BUILD.ts loaded first", async () => {
    const rootFirst = await Workspace.make(root, root)
    const synthesizedFirst = [...(await rootFirst.packageTargets("units/one")).keys()]

    const laterFirst = await Workspace.make(root, root)
    await laterFirst.targets("//later/...")
    const synthesizedSecond = [...(await laterFirst.packageTargets("units/one")).keys()]

    expect(synthesizedFirst).toEqual(["rootRule"])
    expect(synthesizedSecond).toEqual(synthesizedFirst)
  })

  it("orders the discovered declarations by declaring package, then export name", async () => {
    const workspace = await Workspace.make(root, root)
    await workspace.targets("//...")
    expect(workspace.defaultRules.map((entry) => [entry.packagePath, entry.name])).toEqual([
      ["", "rootRule"],
      ["later", "laterRule"]
    ])
  })
})
