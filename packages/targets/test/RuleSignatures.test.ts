/**
 * What a rule's attrs may say, and what the config-file path form expands to.
 *
 * The two properties are one change: the toolchain left every rule's attrs, so
 * a path form can name a config file without also having to name a manager.
 */
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { BiomeCheck } from "../src/BiomeCheck.ts"
import { Dprint } from "../src/Dprint.ts"
import { EsLint } from "../src/EsLint.ts"
import * as Input from "../src/Input.ts"
import { StandardPackage } from "../src/StandardPackage.ts"
import * as Target from "../src/Target.ts"
import { TsBuild } from "../src/TsBuild.ts"
import { Typecheck } from "../src/Typecheck.ts"
import { Vitest } from "../src/Vitest.ts"
import { VitestCoverage } from "../src/VitestCoverage.ts"
import { VitestWatch } from "../src/VitestWatch.ts"
import "./toolchain.ts"

/** Every rule the catalog exports, by the name a BUILD.ts author writes. */
const catalog = await import("../src/Smithers.ts")

/** A rule is anything callable that carries an id and an attrs schema. */
const rules = Object.entries(catalog).flatMap(([name, value]) =>
  typeof value === "function" && "attrs" in value && "id" in value
    ? [[name, value as { readonly id: string; readonly attrs: Schema.Top }] as const]
    : []
)

describe("no rule's attrs schema names a package manager", () => {
  it("finds the rules to check", () => {
    expect(rules.length).toBeGreaterThan(20)
  })

  it.each(rules)("%s", (_name, rule) => {
    const schema = JSON.stringify(Schema.toJsonSchemaDocument(rule.attrs))
    expect(schema).not.toContain("PackageManager")
    expect(schema).not.toContain("packageManager")
  })
})

/** The declared inputs of one target, as plain comparable data. */
const inputsOf = (target: Target.AnyTarget): unknown => Target.metadata(target).inputs

describe("the config-file path form declares the same inputs as the inline form", () => {
  const standard = StandardPackage({ deps: [], cwd: "packages/plan" })

  it("Vitest matches the StandardPackage test target", () => {
    expect(inputsOf(Vitest("packages/plan/vitest.config.ts"))).toEqual(inputsOf(standard.test))
  })

  it("Typecheck matches the StandardPackage check target", () => {
    expect(inputsOf(Typecheck("packages/plan/tsconfig.test.json"))).toEqual(inputsOf(standard.check))
  })

  it("TsBuild matches the StandardPackage lib target", () => {
    expect(inputsOf(TsBuild("packages/plan/tsconfig.json"))).toEqual(inputsOf(standard.lib))
  })

  it("EsLint matches the StandardPackage lint target", () => {
    expect(inputsOf(EsLint("packages/plan/eslint.config.js"))).toEqual(inputsOf(standard.lint))
  })

  it("Dprint matches the StandardPackage fmt target", () => {
    expect(inputsOf(Dprint("packages/plan/dprint.json"))).toEqual(inputsOf(standard.fmt))
  })

  it("VitestWatch matches its own inline form", () => {
    const inline = VitestWatch({
      tests: [Input.glob("test/**/*.test.ts")],
      sources: [Input.glob("src/**/*.ts")],
      deps: [],
      config: Input.file("vitest.config.ts"),
      environment: "node",
      cwd: "packages/plan"
    })
    expect(inputsOf(VitestWatch("packages/plan/vitest.config.ts"))).toEqual(inputsOf(inline))
  })

  it("VitestCoverage matches its own inline form", () => {
    const inline = VitestCoverage({
      tests: [Input.glob("test/**/*.test.ts")],
      sources: [Input.glob("src/**/*.ts")],
      deps: [],
      config: Input.file("vitest.config.ts"),
      provider: "v8",
      reportsDirectory: "coverage",
      thresholds: { branches: 0, functions: 0, lines: 0, statements: 0 },
      cwd: "packages/plan"
    })
    expect(inputsOf(VitestCoverage("packages/plan/vitest.config.ts"))).toEqual(inputsOf(inline))
  })

  it("BiomeCheck matches its own inline form", () => {
    const inline = BiomeCheck({
      sources: [Input.glob("src/**/*.ts"), Input.glob("test/**/*.ts")],
      deps: [],
      config: Input.file("biome.json"),
      lint: true,
      format: true,
      unsafe: false,
      cwd: "packages/plan"
    })
    expect(inputsOf(BiomeCheck("packages/plan/biome.json"))).toEqual(inputsOf(inline))
  })
})

describe("the path form derives the directory the tool runs in", () => {
  it("takes the directory that holds the named file", () => {
    expect((Target.metadata(Vitest("packages/plan/vitest.config.ts")).attrs as { readonly cwd: string }).cwd)
      .toBe("packages/plan")
  })

  it("runs at the workspace root when the path names no directory", () => {
    const metadata = Target.metadata(Vitest("vitest.config.ts"))
    expect((metadata.attrs as { readonly cwd: string }).cwd).toBe(".")
    expect(metadata.inputs).toContainEqual({ _tag: "File", path: "vitest.config.ts" })
  })
})
