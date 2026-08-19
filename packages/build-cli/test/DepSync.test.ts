import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as DepSync from "../src/DepSync.ts"

/**
 * The three packages every fixture resolves against. They are the real shape:
 * `engine` is the package under maintenance, `plan` is a sibling it already
 * declares, and `flow` is the sibling its sources import without declaring.
 */
const packages: ReadonlyArray<DepSync.Package> = [
  { name: "@smthrs/engine", directory: "packages/engine" },
  { name: "@smthrs/flow", directory: "packages/flow" },
  { name: "@smthrs/plan", directory: "packages/plan" }
]

/**
 * An engine-shaped BUILD.ts. Its doc comment writes a `deps` array that is not
 * a declaration, which is the shape `packages/flow/BUILD.ts` really has, and
 * the edit must not land there.
 */
const engineBuild = [
  "/**",
  " * Standard package targets plus one cross-package edge.",
  " *",
  " * Equivalent to `StandardPackage({ cwd: \"packages/engine\", deps: [plan] })`,",
  " * which is the expansion this file exists to make explicit.",
  " */",
  "import { Smithers } from \"@smthrs/targets\"",
  "import { lib as plan } from \"../plan/BUILD.ts\"",
  "",
  "const standard = Smithers.StandardPackage({ deps: [plan], cwd: \"packages/engine\" })",
  "",
  "export const lib = standard.lib",
  "export const lint = standard.lint",
  ""
].join("\n")

/** A BUILD.ts with no dependency section at all: no `deps` array anywhere. */
const bareBuild = [
  "/** Bare standard package: the macro supplies every attribute. */",
  "import { Smithers } from \"@smthrs/targets\"",
  "",
  "export const { lib, test } = Smithers.StandardPackage({ cwd: \"packages/engine\" })",
  ""
].join("\n")

const source = (specifier: string): ReadonlyArray<DepSync.Source> => [{
  path: "packages/engine/src/Engine.ts",
  text: `import { make } from ${JSON.stringify(specifier)}\n\nexport const engine = make()\n`
}]

const request = (options: {
  readonly contents: string
  readonly sources: ReadonlyArray<DepSync.Source>
}): DepSync.Request => ({
  path: "packages/engine/BUILD.ts",
  contents: options.contents,
  sources: options.sources,
  packages
})

const permissive: DepSync.Environment = { production: false, strict: false }

let root: string

beforeEach(async () => {
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-depsync-"))
  await Fs.mkdir(NodePath.join(root, "packages/engine"), { recursive: true })
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

const stage = async (contents: string): Promise<void> => {
  await Fs.writeFile(NodePath.join(root, "packages/engine/BUILD.ts"), contents, "utf8")
}

const staged = (): Promise<string> => Fs.readFile(NodePath.join(root, "packages/engine/BUILD.ts"), "utf8")

describe("check mode", () => {
  it("reports drift when a source imports a sibling the BUILD.ts does not list", async () => {
    const input = request({ contents: engineBuild, sources: source("@smthrs/flow") })
    const result = DepSync.plan(input)
    expect(result.declared).toEqual(["packages/plan"])
    expect(result.missing).toHaveLength(1)
    expect(result.missing[0]).toMatchObject({
      name: "@smthrs/flow",
      directory: "packages/flow",
      binding: "flow",
      evidence: { file: "packages/engine/src/Engine.ts", line: 1, typeOnly: false }
    })
    await expect(Effect.runPromise(DepSync.check(input))).rejects.toMatchObject({
      _tag: "smithers-build/DriftError",
      path: "packages/engine/BUILD.ts"
    })
    expect(DepSync.describe(result)).toContain("packages/flow (@smthrs/flow)")
    expect(DepSync.describe(result)).toContain("packages/engine/src/Engine.ts:1")
  })

  it("accepts a file whose declared edges cover every imported sibling", async () => {
    const input = request({ contents: engineBuild, sources: source("@smthrs/plan") })
    const result = await Effect.runPromise(DepSync.check(input))
    expect(result.missing).toEqual([])
    expect(result.contents).toBe(engineBuild)
    expect(result.blocked).toBeUndefined()
  })

  it("never reports a declared edge no source imports, and never mutates", async () => {
    const before = engineBuild
    const input = request({ contents: before, sources: [] })
    const result = await Effect.runPromise(DepSync.check(input))
    expect(result.missing).toEqual([])
    expect(result.contents).toBe(before)
  })

  it("ignores the package's own name, a non-workspace package, and a builtin", async () => {
    const sources: ReadonlyArray<DepSync.Source> = [{
      path: "packages/engine/src/Engine.ts",
      text: [
        "import * as Fs from \"node:fs\"",
        "import * as Effect from \"effect/Effect\"",
        "import { self } from \"@smthrs/engine/Self.ts\"",
        "import { local } from \"./Local.ts\"",
        ""
      ].join("\n")
    }]
    const result = DepSync.plan(request({ contents: engineBuild, sources }))
    expect(result.missing).toEqual([])
  })
})

describe("type-only imports", () => {
  it("counts a type-only import as an edge, which is the declared policy", () => {
    const sources: ReadonlyArray<DepSync.Source> = [{
      path: "packages/engine/src/Engine.ts",
      text: "import type { Flow } from \"@smthrs/flow\"\n\nexport type Alias = Flow\n"
    }]
    const result = DepSync.plan(request({ contents: engineBuild, sources }))
    expect(result.missing).toHaveLength(1)
    expect(result.missing[0]?.evidence.typeOnly).toBe(true)
    expect(DepSync.describe(result)).toContain("type-only import")
  })
})

describe("write mode", () => {
  it("adds exactly the missing edge and leaves every other byte identical", async () => {
    await stage(engineBuild)
    const result = await Effect.runPromise(
      DepSync.write(
        { workspaceRoot: root, environment: permissive },
        request({ contents: engineBuild, sources: source("@smthrs/flow") })
      )
    )
    const after = await staged()
    expect(after).toBe(result.contents)
    expect(after).toBe([
      "/**",
      " * Standard package targets plus one cross-package edge.",
      " *",
      " * Equivalent to `StandardPackage({ cwd: \"packages/engine\", deps: [plan] })`,",
      " * which is the expansion this file exists to make explicit.",
      " */",
      "import { Smithers } from \"@smthrs/targets\"",
      "import { lib as plan } from \"../plan/BUILD.ts\"",
      "import { lib as flow } from \"../flow/BUILD.ts\"",
      "",
      "const standard = Smithers.StandardPackage({ deps: [plan, flow], cwd: \"packages/engine\" })",
      "",
      "export const lib = standard.lib",
      "export const lint = standard.lint",
      ""
    ].join("\n"))
    // Undoing the two intended edits restores the file byte for byte, which is
    // the whole surgical claim: one inserted import line, one array element,
    // and no other byte of the doc comment, blank lines, or declarations.
    const undone = after
      .replace("import { lib as flow } from \"../flow/BUILD.ts\"\n", "")
      .replace("deps: [plan, flow]", "deps: [plan]")
    expect(undone).toBe(engineBuild)
  })

  it("fills an empty deps array without adding a separator", async () => {
    const contents = engineBuild.replace("{ deps: [plan], cwd", "{ deps: [], cwd")
    await stage(contents)
    const result = await Effect.runPromise(
      DepSync.write(
        { workspaceRoot: root, environment: permissive },
        request({ contents, sources: source("@smthrs/flow") })
      )
    )
    expect(result.contents).toContain("deps: [flow]")
    expect(await staged()).toBe(result.contents)
  })

  it("reuses an existing sibling import instead of writing a second one", async () => {
    const contents = engineBuild.replace("{ deps: [plan], cwd", "{ deps: [], cwd")
    const result = DepSync.plan(request({ contents, sources: source("@smthrs/plan") }))
    expect(result.missing).toHaveLength(1)
    expect(result.missing[0]?.binding).toBe("plan")
    expect(result.contents).toContain("deps: [plan]")
    expect(result.contents.match(/from "\.\.\/plan\/BUILD\.ts"/g)).toHaveLength(1)
  })

  it("writes nothing when there is no drift", async () => {
    await stage(engineBuild)
    const before = await Fs.stat(NodePath.join(root, "packages/engine/BUILD.ts"))
    const result = await Effect.runPromise(
      DepSync.write(
        { workspaceRoot: root, environment: permissive },
        request({ contents: engineBuild, sources: source("@smthrs/plan") })
      )
    )
    expect(result.missing).toEqual([])
    const after = await Fs.stat(NodePath.join(root, "packages/engine/BUILD.ts"))
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(await staged()).toBe(engineBuild)
  })

  it("round-trips: what write produces, check accepts", async () => {
    await stage(engineBuild)
    const sources = source("@smthrs/flow")
    await Effect.runPromise(
      DepSync.write({ workspaceRoot: root, environment: permissive }, request({ contents: engineBuild, sources }))
    )
    const rewritten = await staged()
    const second = await Effect.runPromise(DepSync.check(request({ contents: rewritten, sources })))
    expect(second.missing).toEqual([])
    expect(second.declared).toEqual(["packages/flow", "packages/plan"])
    const third = await Effect.runPromise(
      DepSync.write({ workspaceRoot: root, environment: permissive }, request({ contents: rewritten, sources }))
    )
    expect(third.contents).toBe(rewritten)
  })
})

describe("the write gate", () => {
  it("refuses write mode under NODE_ENV=production and reads nothing", async () => {
    await stage(engineBuild)
    const environment = DepSync.environment({ env: { NODE_ENV: "production" }, strict: false })
    expect(environment).toEqual({ production: true, strict: false })
    expect(DepSync.refusal(environment)).toContain("NODE_ENV")
    await expect(Effect.runPromise(
      DepSync.write(
        { workspaceRoot: root, environment },
        request({ contents: engineBuild, sources: source("@smthrs/flow") })
      )
    )).rejects.toMatchObject({
      _tag: "smithers-build/DepSyncRefusedError",
      path: "packages/engine/BUILD.ts"
    })
    expect(await staged()).toBe(engineBuild)
  })

  it("refuses write mode under the strict flag", async () => {
    await stage(engineBuild)
    const environment = DepSync.environment({ env: { NODE_ENV: "development" }, strict: true })
    expect(DepSync.refusal(environment)).toContain("strict")
    await expect(Effect.runPromise(
      DepSync.write(
        { workspaceRoot: root, environment },
        request({ contents: engineBuild, sources: source("@smthrs/flow") })
      )
    )).rejects.toMatchObject({ _tag: "smithers-build/DepSyncRefusedError" })
    expect(await staged()).toBe(engineBuild)
  })

  it("allows write mode when neither gate is set", () => {
    expect(DepSync.refusal(DepSync.environment({ env: {}, strict: false }))).toBeUndefined()
    expect(DepSync.refusal(DepSync.environment({ env: { NODE_ENV: "test" }, strict: false }))).toBeUndefined()
  })
})

describe("a BUILD.ts with no dependency section", () => {
  it("reports no drift and stays byte-identical when nothing is imported", async () => {
    const result = await Effect.runPromise(DepSync.check(request({ contents: bareBuild, sources: [] })))
    expect(result.missing).toEqual([])
    expect(result.contents).toBe(bareBuild)
  })

  it("reports the edge, refuses to place it, and corrupts nothing", async () => {
    await stage(bareBuild)
    const input = request({ contents: bareBuild, sources: source("@smthrs/flow") })
    const result = DepSync.plan(input)
    expect(result.missing).toHaveLength(1)
    expect(result.blocked).toContain("no deps array")
    expect(result.contents).toBe(bareBuild)
    await expect(Effect.runPromise(DepSync.write({ workspaceRoot: root, environment: permissive }, input)))
      .rejects.toMatchObject({ _tag: "smithers-build/DepSyncPlacementError" })
    expect(await staged()).toBe(bareBuild)
    expect(DepSync.describe(result)).toContain("no deps array")
  })

  it("refuses to place an import into a file that writes none", () => {
    const contents = "export const lib = { deps: [] }\n"
    const result = DepSync.plan(request({ contents, sources: source("@smthrs/flow") }))
    expect(result.blocked).toContain("no import statement")
    expect(result.contents).toBe(contents)
  })
})

describe("the dependency section is the library target's", () => {
  it("skips a deps array that belongs to a PackageDefaults macro, not to lib", () => {
    // The shape of packages/build/BUILD.ts: `lib` comes from a StandardPackage
    // call with no deps key, and the first `deps: [` in the file is a template
    // for other packages. Editing it would add the edge to every synthesized
    // package, so the edge is reported and refused instead.
    const contents = [
      "import { Smithers } from \"@smthrs/targets\"",
      "",
      "const standard = Smithers.StandardPackage({ cwd: \"packages/engine\" })",
      "",
      "export const lib = standard.lib",
      "",
      "export const packageDefaults = Smithers.PackageDefaults({",
      "  directories: \"packages/*\",",
      "  marker: \"package.json\",",
      "  macro: (attrs: { readonly cwd: string }) => {",
      "    const inner = Smithers.StandardPackage({ deps: [], cwd: attrs.cwd })",
      "    return { ...inner }",
      "  }",
      "})",
      ""
    ].join("\n")
    const result = DepSync.plan(request({ contents, sources: source("@smthrs/flow") }))
    expect(result.missing).toHaveLength(1)
    expect(result.blocked).toContain("`lib` target declares no deps array")
    expect(result.contents).toBe(contents)
  })

  it("follows `export const lib = standard.lib` to the statement that builds it", () => {
    const contents = [
      "import { Smithers } from \"@smthrs/targets\"",
      "",
      "export const other = Smithers.Typecheck({ srcs: [], deps: [], cwd: \"packages/engine\" })",
      "",
      "const standard = Smithers.StandardPackage({ deps: [], cwd: \"packages/engine\" })",
      "",
      "export const lib = standard.lib",
      ""
    ].join("\n")
    const result = DepSync.plan(request({ contents, sources: source("@smthrs/flow") }))
    expect(result.blocked).toBeUndefined()
    expect(result.contents).toContain("Smithers.Typecheck({ srcs: [], deps: [], cwd")
    expect(result.contents).toContain("Smithers.StandardPackage({ deps: [flow], cwd")
  })

  it("edits the deps array of a multi-line lib declaration, not a later target's", () => {
    const contents = [
      "import { Smithers } from \"@smthrs/targets\"",
      "",
      "export const lint = Smithers.EsLint({",
      "  sources: [],",
      "  deps: [],",
      "  cwd: \"packages/engine\"",
      "})",
      "",
      "export const lib = Smithers.TsBuild({",
      "  srcs: [],",
      "  deps: [],",
      "  cwd: \"packages/engine\"",
      "})",
      ""
    ].join("\n")
    const result = DepSync.plan(request({ contents, sources: source("@smthrs/flow") }))
    expect(result.blocked).toBeUndefined()
    expect(result.contents).toBe(
      contents
        .replace(
          "import { Smithers } from \"@smthrs/targets\"",
          "import { Smithers } from \"@smthrs/targets\"\nimport { lib as flow } from \"../flow/BUILD.ts\""
        )
        .replace("srcs: [],\n  deps: [],", "srcs: [],\n  deps: [flow],")
    )
  })

  it("reports a file that declares no lib target", () => {
    const contents = "import { Smithers } from \"@smthrs/targets\"\nexport const lint = Smithers.EsLint({ deps: [] })\n"
    const result = DepSync.plan(request({ contents, sources: source("@smthrs/flow") }))
    expect(result.blocked).toContain("no `lib` target")
    expect(result.contents).toBe(contents)
  })

  it("keeps the file's semicolon style on the inserted import", () => {
    const contents = [
      "import { Smithers } from \"@smthrs/targets\";",
      "",
      "export const lib = Smithers.TsBuild({ srcs: [], deps: [], cwd: \"packages/engine\" });",
      ""
    ].join("\n")
    const result = DepSync.plan(request({ contents, sources: source("@smthrs/flow") }))
    expect(result.contents).toContain(
      "import { Smithers } from \"@smthrs/targets\";\nimport { lib as flow } from \"../flow/BUILD.ts\";\n"
    )
  })
})

describe("masking", () => {
  it("ignores a deps array written inside a string literal, escapes included", () => {
    const contents = engineBuild.replace(
      "StandardPackage({ deps: [plan]",
      "StandardPackage({ note: \"a \\\" quote and deps: [ghost]\", deps: [plan]"
    )
    const result = DepSync.plan(request({ contents, sources: source("@smthrs/flow") }))
    expect(result.contents).toContain("deps: [ghost]")
    expect(result.contents).toContain("deps: [plan, flow]")
  })

  it("ignores an unterminated deps array", () => {
    const contents = "import { Smithers } from \"@smthrs/targets\"\nexport const lib = Smithers.Rule({ deps: [\n"
    const result = DepSync.plan(request({ contents, sources: source("@smthrs/flow") }))
    expect(result.blocked).toContain("no deps array")
    expect(result.contents).toBe(contents)
  })
})
