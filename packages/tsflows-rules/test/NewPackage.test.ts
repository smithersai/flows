import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { boilerplate, scaffold, type ScaffoldPayload, type ScaffoldReport } from "../src/NewPackage.ts"
import * as PackageJsonTemplate from "../src/PackageJsonTemplate.ts"

let root: string

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "tsflows-newpackage-")))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

const template = PackageJsonTemplate.make({
  license: "MIT",
  author: "flows",
  engines: { node: ">=22.19.0" },
  scripts: PackageJsonTemplate.standardScripts
})

const payload: ScaffoldPayload = {
  directory: "packages",
  version: "0.1.0",
  license: "MIT",
  fields: template.fields,
  tsconfigExtends: "../../tsconfig.json"
}

const run = (packageName?: string): Promise<ScaffoldReport> =>
  Effect.runPromise(scaffold({ workspaceRoot: root, packageName }, payload))

const failure = (packageName?: string): Promise<{ readonly message: string }> =>
  Effect.runPromise(Effect.flip(scaffold({ workspaceRoot: root, packageName }, payload)))

describe("scaffold", () => {
  it("creates a package a default rule can pick up, with no BUILD.ts", async () => {
    const report = await run("@smthrs/widget")
    expect(report.directory).toBe("packages/widget")
    expect(report.files).toEqual([
      "packages/widget/package.json",
      "packages/widget/tsconfig.json",
      "packages/widget/src/index.ts",
      "packages/widget/test/index.test.ts",
      "packages/widget/README.md"
    ])
    expect(await Fs.readdir(NodePath.join(root, "packages/widget"))).not.toContain("BUILD.ts")
  })

  it("writes a manifest carrying the template fields", async () => {
    await run("@smthrs/widget")
    const manifest = JSON.parse(
      await Fs.readFile(NodePath.join(root, "packages/widget/package.json"), "utf8")
    ) as Record<string, unknown>
    expect(manifest["name"]).toBe("@smthrs/widget")
    expect(manifest["version"]).toBe("0.1.0")
    expect(manifest["license"]).toBe("MIT")
    expect(manifest["author"]).toBe("flows")
    expect(manifest["engines"]).toEqual({ node: ">=22.19.0" })
    expect(manifest["scripts"]).toEqual(PackageJsonTemplate.standardScripts)
    // The manifest is already in the generated key order.
    expect(Object.keys(manifest).slice(0, 3)).toEqual(["name", "version", "license"])
  })

  it("writes a source file and a test that exercises it", async () => {
    await run("@smthrs/my-widget")
    const source = await Fs.readFile(NodePath.join(root, "packages/my-widget/src/index.ts"), "utf8")
    const test = await Fs.readFile(NodePath.join(root, "packages/my-widget/test/index.test.ts"), "utf8")
    expect(source).toContain("export const myWidget = \"@smthrs/my-widget\"")
    expect(test).toContain("import { myWidget } from \"../src/index.ts\"")
    const tsconfig = JSON.parse(
      await Fs.readFile(NodePath.join(root, "packages/my-widget/tsconfig.json"), "utf8")
    ) as { extends: string }
    expect(tsconfig.extends).toBe("../../tsconfig.json")
  })

  it("names the flag when no package name was supplied", async () => {
    expect((await failure()).message).toContain("--name <package-name>")
    expect((await failure("")).message).toContain("--name <package-name>")
  })

  it("refuses an invalid npm name and an existing directory", async () => {
    expect((await failure("Widget")).message).toContain("lowercase")
    await run("@smthrs/widget")
    expect((await failure("@smthrs/widget")).message).toContain("already exists")
  })

  it("renders the same tree every time, with no model in reach", () => {
    expect(boilerplate("@smthrs/widget", payload)).toEqual(boilerplate("@smthrs/widget", payload))
  })
})
