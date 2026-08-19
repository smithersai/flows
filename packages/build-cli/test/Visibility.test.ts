/**
 * Plan-time visibility: who may depend on a target, decided from real imports.
 *
 * The decision has two halves and both are tested here. `Imports.admits` is the
 * pure half: a shorthand, two directories, and a manifest answer yes or no with
 * no filesystem. The workspace half resolves an import specifier to a target
 * label and refuses the edge, which needs a real scratch workspace because
 * resolution reads a manifest `exports` map and a package's declared inputs.
 *
 * Enforcement is package scoped and a package opts in by declaring. A target's
 * metadata carries `Visibility.private` both when its author wrote it and when
 * its author wrote nothing, so enforcing the default would fail every
 * unmigrated workspace on its first plan. A unit therefore enforces only once
 * one of its targets declares something other than private, which is why the
 * private cases below declare a second, public target beside the private one.
 */
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as Imports from "../src/Imports.ts"
import * as Planner from "../src/Planner.ts"
import { Workspace } from "../src/Workspace.ts"

vi.mock("node:child_process", () => ({
  execFile: (
    _file: unknown,
    _args: unknown,
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ): void => callback(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }), "", "")
}))

const consumer = (
  directory: string,
  options: { readonly group?: string | undefined; readonly packageDirectory?: string } = {}
): Imports.Consumer => ({
  label: `//${directory}:lib`,
  directory,
  packageDirectory: options.packageDirectory ?? directory,
  manifest: {
    directory: options.packageDirectory ?? directory,
    name: `@t/${directory}`,
    version: "0.1.0",
    smthrs: { group: options.group }
  }
})

const producer: Imports.Producer = {
  label: "//lib:lib",
  directory: "lib",
  packageDirectory: "lib"
}

describe("Imports.scan", () => {
  it("reads every import form, including type-only and dynamic", () => {
    const found = Imports.scan(
      [
        `import { a } from "./a.ts"`,
        `import type { B } from "./b.ts"`,
        `export type { C } from "./c.ts"`,
        `export * from "./d.ts"`,
        `import "./e.ts"`,
        `const f = await import("./f.ts")`,
        `const g = require("./g.ts")`
      ].join("\n")
    )
    expect(found.map((entry) => entry.specifier)).toEqual([
      "./a.ts",
      "./b.ts",
      "./c.ts",
      "./d.ts",
      "./e.ts",
      "./f.ts",
      "./g.ts"
    ])
    // The per-package madge guards pass `skipTypeImports: true`. A type import
    // is still a compile-time edge into another package's source, so visibility
    // covers it and this scanner reports it.
    expect(found.filter((entry) => entry.typeOnly).map((entry) => entry.specifier)).toEqual(["./b.ts", "./c.ts"])
    expect(found[0]?.line).toBe(1)
    expect(found[4]?.line).toBe(5)
  })

  it("ignores a specifier written inside a comment or another string", () => {
    const found = Imports.scan(
      [
        `// import { a } from "./commented.ts"`,
        `/* import { b } from "./blocked.ts" */`,
        `const text = "import { c } from './quoted.ts'"`,
        `const built = \`./\${name}.ts\``,
        `import { d } from "./real.ts"`
      ].join("\n")
    )
    expect(found.map((entry) => entry.specifier)).toEqual(["./real.ts"])
  })
})

describe("Imports.parseBare", () => {
  it("splits a package name from its subpath and refuses what cannot be one", () => {
    expect(Imports.parseBare("@t/lib")).toEqual({ name: "@t/lib", subpath: "." })
    expect(Imports.parseBare("@t/lib/api")).toEqual({ name: "@t/lib", subpath: "./api" })
    expect(Imports.parseBare("effect/Schema")).toEqual({ name: "effect", subpath: "./Schema" })
    expect(Imports.parseBare("./relative.ts")).toBeUndefined()
    expect(Imports.parseBare("node:path")).toBeUndefined()
    expect(Imports.parseBare("#internal")).toBeUndefined()
  })
})

describe("Imports.exportTargets", () => {
  it("resolves a subpath map, a wildcard, and a conditions object", () => {
    const exports = {
      ".": { types: "./src/index.ts", import: "./src/index.ts" },
      "./*": "./src/*.ts",
      "./internal/*": null
    }
    expect(Imports.exportTargets(exports, ".")).toEqual(["src/index.ts", "src/index.ts"])
    expect(Imports.exportTargets(exports, "./api")).toEqual(["src/api.ts"])
    expect(Imports.exportTargets(exports, "./internal/secret")).toEqual([])
    expect(Imports.exportTargets("./src/index.ts", ".")).toEqual(["src/index.ts"])
  })
})

describe("Imports.admits", () => {
  it("private admits the declaring directory only", () => {
    const visibility = { _tag: "Private" } as const
    expect(Imports.admits(visibility, producer, consumer("lib"))).toBe(true)
    expect(Imports.admits(visibility, producer, consumer("app"))).toBe(false)
    expect(Imports.admits(visibility, producer, consumer("lib/tools", { packageDirectory: "lib" }))).toBe(false)
  })

  it("package admits every directory of the declaring npm package", () => {
    const visibility = { _tag: "Package" } as const
    expect(Imports.admits(visibility, producer, consumer("lib/tools", { packageDirectory: "lib" }))).toBe(true)
    expect(Imports.admits(visibility, producer, consumer("app"))).toBe(false)
  })

  it("subpackages admits the declaring directory and everything below it", () => {
    const visibility = { _tag: "Subpackages" } as const
    expect(Imports.admits(visibility, producer, consumer("lib"))).toBe(true)
    expect(Imports.admits(visibility, producer, consumer("lib/tools", { packageDirectory: "lib" }))).toBe(true)
    expect(Imports.admits(visibility, producer, consumer("app"))).toBe(false)
  })

  it("public admits anywhere", () => {
    expect(Imports.admits({ _tag: "Public" }, producer, consumer("app"))).toBe(true)
  })

  it("of admits the listed labels only", () => {
    const visibility = { _tag: "Labels", labels: ["//app", "//tools/cli:lib", "//vendor/..."] } as const
    expect(Imports.admits(visibility, producer, consumer("app"))).toBe(true)
    expect(Imports.admits(visibility, producer, { ...consumer("tools/cli"), label: "//tools/cli:lib" })).toBe(true)
    expect(Imports.admits(visibility, producer, { ...consumer("tools/cli"), label: "//tools/cli:test" })).toBe(false)
    expect(Imports.admits(visibility, producer, consumer("vendor/one"))).toBe(true)
    expect(Imports.admits(visibility, producer, consumer("other"))).toBe(false)
  })

  it("group admits by manifest predicate and refuses an absent manifest", () => {
    const visibility = {
      _tag: "Group",
      where: (manifest: { readonly smthrs: { readonly group: string | undefined } }) =>
        manifest.smthrs.group === "engine"
    } as const
    expect(Imports.admits(visibility, producer, consumer("app", { group: "engine" }))).toBe(true)
    expect(Imports.admits(visibility, producer, consumer("app", { group: "tooling" }))).toBe(false)
    expect(Imports.admits(visibility, producer, { ...consumer("app"), manifest: undefined })).toBe(false)
  })
})

describe("Imports.describe", () => {
  it("renders a declaration the way a BUILD.ts file writes it", () => {
    expect(Imports.describe({ _tag: "Private" })).toBe("Visibility.private")
    expect(Imports.describe({ _tag: "Labels", labels: ["//app"] })).toBe(`Visibility.of("//app")`)
  })
})

let root: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const smithers = NodePath.resolve(import.meta.dirname, "../../targets/src/Smithers.ts")

/**
 * A BUILD.ts declaring one target per named visibility.
 *
 * No shipped rule takes a visibility from its attrs, so the declaration is a
 * rule-level option, which is where `Target.MakeOptions` puts it.
 */
const build = (
  id: string,
  targets: ReadonlyArray<{ readonly name: string; readonly visibility: string; readonly srcs: string }>
): string =>
  `import * as Schema from "effect/Schema"
import { glob, Input, Target, Visibility } from "${smithers}"

const Attrs = Schema.Struct({ srcs: Schema.Array(Input.Declared) })

${
    targets.map((target) =>
      `const ${target.name}Rule = Target.make("${id}${target.name}", {
  attrs: Attrs,
  kinds: ["build"],
  visibility: ${target.visibility},
  implementation: () => Target.notImplemented("${id}${target.name}")
})
export const ${target.name} = ${target.name}Rule({ srcs: [${target.srcs}] })`
    ).join("\n\n")
  }
`

const manifest = (name: string, options: { readonly group?: string } = {}): string =>
  `${
    JSON.stringify(
      {
        name,
        version: "0.1.0",
        type: "module",
        ...(options.group === undefined ? {} : { smthrs: { group: options.group } }),
        exports: { ".": "./src/index.ts", "./*": "./src/*.ts" }
      },
      null,
      2
    )
  }\n`

const plan = async (label: string): Promise<Planner.Plan> => {
  const workspace = await Workspace.make(root, root)
  return Planner.make(workspace, "build", label)
}

/** Declares `lib` with one visibility and a public sibling that opts the unit in. */
const declareLib = (visibility: string): Promise<void> =>
  write(
    "lib/BUILD.ts",
    build("VisibilityTestLib", [
      { name: "lib", visibility, srcs: `glob("src/**/*.ts")` },
      { name: "open", visibility: "Visibility.public", srcs: `glob("open/**/*.ts")` }
    ])
  )

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-cli-visibility-")))
  await write("WORKSPACE.ts", "export {}\n")

  await write("lib/package.json", manifest("@t/lib"))
  await write("lib/src/api.ts", "export const api = 1\n")
  await write("lib/open/free.ts", "export const free = 1\n")
  await declareLib("Visibility.public")

  await write("app/package.json", manifest("@t/app", { group: "engine" }))
  await write(
    "app/BUILD.ts",
    build("VisibilityTestApp", [{ name: "lib", visibility: "undefined", srcs: `glob("src/**/*.ts")` }])
  )
  await write("app/src/index.ts", `import { api } from "@t/lib/api"\nexport const used = api\n`)

  // A second unit inside the `lib` npm package: same manifest, different
  // declaring directory. It separates `Visibility.package` from
  // `Visibility.private`, which no single-directory workspace can.
  await write(
    "lib/tools/BUILD.ts",
    build("VisibilityTestTools", [{ name: "lib", visibility: "undefined", srcs: `glob("*.ts")` }])
  )
  await write("lib/tools/run.ts", `import { api } from "../src/api.ts"\nexport const used = api\n`)
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("plan-time visibility", () => {
  it("admits a public target from a sibling package", async () => {
    const answered = await plan("//app:lib")
    expect(answered.roots).toEqual(["//app:lib"])
  })

  it("refuses a private target from a sibling package", async () => {
    await declareLib("Visibility.private")
    await expect(plan("//app:lib")).rejects.toThrow(Imports.VisibilityError)
  })

  it("names the importing file, the imported label, and the declared visibility", async () => {
    await declareLib("Visibility.private")
    await expect(plan("//app:lib")).rejects.toThrow(/app\/src\/index\.ts:1 imports "@t\/lib\/api"/)
    await expect(plan("//app:lib")).rejects.toThrow(/resolves to \/\/lib:lib/)
    await expect(plan("//app:lib")).rejects.toThrow(/declares Visibility\.private and does not admit \/\/app:lib/)
  })

  it("refuses a type-only import the madge guards would skip", async () => {
    await declareLib("Visibility.private")
    await write("app/src/index.ts", `import type { api } from "@t/lib/api"\nexport type Used = typeof api\n`)
    await expect(plan("//app:lib")).rejects.toThrow(Imports.VisibilityError)
  })

  it("admits the same package from another unit, and refuses a sibling package", async () => {
    await declareLib("Visibility.package")
    const answered = await plan("//lib/tools:lib")
    expect(answered.roots).toEqual(["//lib/tools:lib"])
    await expect(plan("//app:lib")).rejects.toThrow(Imports.VisibilityError)
  })

  it("refuses another unit of the same package when the declaration is private", async () => {
    await declareLib("Visibility.private")
    await expect(plan("//lib/tools:lib")).rejects.toThrow(/declares Visibility\.private/)
  })

  it("admits a nested unit under subpackages", async () => {
    await declareLib("Visibility.subpackages")
    const answered = await plan("//lib/tools:lib")
    expect(answered.roots).toEqual(["//lib/tools:lib"])
    await expect(plan("//app:lib")).rejects.toThrow(Imports.VisibilityError)
  })

  it("admits only the labels of listed by of()", async () => {
    await declareLib(`Visibility.of("//app")`)
    expect((await plan("//app:lib")).roots).toEqual(["//app:lib"])
    await expect(plan("//lib/tools:lib")).rejects.toThrow(/declares Visibility\.of\("\/\/app"\)/)
  })

  it("resolves group() through smthrs.group in the package manifest", async () => {
    await declareLib(`Visibility.group({ where: (pkg) => pkg.smthrs.group === "engine" })`)
    expect((await plan("//app:lib")).roots).toEqual(["//app:lib"])

    await write("app/package.json", manifest("@t/app", { group: "tooling" }))
    await expect(plan("//app:lib")).rejects.toThrow(/declares Visibility\.group/)
  })

  it("leaves a workspace that declares no visibility permissive", async () => {
    // The repository this build system runs in is exactly this case: 45
    // packages, no visibility declaration, every edge admitted.
    await write(
      "lib/BUILD.ts",
      build("VisibilityTestBare", [{ name: "lib", visibility: "undefined", srcs: `glob("src/**/*.ts")` }])
    )
    await write(
      "lib/tools/BUILD.ts",
      build("VisibilityTestBareTools", [{ name: "lib", visibility: "undefined", srcs: `glob("*.ts")` }])
    )
    expect((await plan("//app:lib")).roots).toEqual(["//app:lib"])
    expect((await plan("//lib/tools:lib")).roots).toEqual(["//lib/tools:lib"])
  })

  it("admits an import of a file no target declares", async () => {
    await declareLib("Visibility.private")
    await write("lib/loose.ts", "export const loose = 1\n")
    await write("app/src/index.ts", `import { loose } from "../../lib/loose.ts"\nexport const used = loose\n`)
    expect((await plan("//app:lib")).roots).toEqual(["//app:lib"])
  })
})
