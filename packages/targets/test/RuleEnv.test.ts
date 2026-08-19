/**
 * The declared environment of a tool-running rule.
 *
 * A variable a tool reads is an input. Until a rule declares it, the value is
 * ambient: two runs under different values share one key, so a cached verdict
 * about `FC_SEED=1` answers for `FC_SEED=2`. That is the same silent-stale
 * class as an undeclared file read. Every tool-running rule now carries an
 * `env` attr, so the value is key material and reaches the child process.
 *
 * The key assertions plan a real workspace through the planner the CLI runs,
 * so they measure the key the executor would cache on rather than a second
 * key computed here. The child-process assertion runs the exec payload the
 * rule planned through `Exec.run`, the same call the exec layer makes.
 */
import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Planner from "../../build-cli/src/Planner.ts"
import { Workspace } from "../../build-cli/src/Workspace.ts"
import { BiomeCheck } from "../src/BiomeCheck.ts"
import { DepsLint } from "../src/DepsLint.ts"
import { Dprint } from "../src/Dprint.ts"
import { EsLint } from "../src/EsLint.ts"
import * as Exec from "../src/Exec.ts"
import * as Input from "../src/Input.ts"
import { PackageLint } from "../src/PackageLint.ts"
import * as Target from "../src/Target.ts"
import { Typecheck } from "../src/Typecheck.ts"
import { Vitest } from "../src/Vitest.ts"
import { VitestCoverage } from "../src/VitestCoverage.ts"
import "./toolchain.ts"

let root: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-rule-env-")))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

/** Every exec payload one target's body plans, in the order the walk reaches them. */
const execPayloads = (target: Target.AnyTarget): ReadonlyArray<Exec.Payload> => {
  const found: Array<Exec.Payload> = []
  const visit = (node: unknown, seen: Set<object>): void => {
    if (node === null || typeof node !== "object" || seen.has(node)) return
    seen.add(node)
    const ast = node as Record<string, unknown>
    if (ast["_tag"] === "ActionCall") {
      if (ast["action"] === "smithers-build/exec") found.push(ast["payload"] as Exec.Payload)
      return
    }
    for (const value of Object.values(ast)) visit(value, seen)
  }
  visit(
    (target as unknown as { readonly body: (attrs: unknown) => { readonly ast: unknown } })
      .body(Target.metadata(target).attrs).ast,
    new Set()
  )
  return found
}

/** The declared environment every exec step of one target carries. */
const plannedEnvironments = (
  target: Target.AnyTarget
): ReadonlyArray<Record<string, string>> => execPayloads(target).map((payload) => ({ ...payload.env }))

describe("every tool-running rule declares its environment", () => {
  const declarations = [
    ["Vitest", (env: Record<string, string>) =>
      Vitest({
        tests: [Input.glob("test/**/*")],
        sources: [Input.glob("src/**/*.ts")],
        deps: [],
        config: Input.file("vitest.config.ts"),
        environment: "node",
        passWithNoTests: false,
        env,
        cwd: "packages/alpha"
      })],
    ["VitestCoverage", (env: Record<string, string>) =>
      VitestCoverage({
        tests: [Input.glob("test/**/*")],
        sources: [Input.glob("src/**/*.ts")],
        deps: [],
        config: Input.file("vitest.config.ts"),
        provider: "v8",
        reportsDirectory: "coverage",
        thresholds: { branches: 0, functions: 0, lines: 0, statements: 0 },
        env,
        cwd: "packages/alpha"
      })],
    ["Typecheck", (env: Record<string, string>) =>
      Typecheck({
        srcs: [Input.glob("src/**/*.ts")],
        deps: [],
        tsconfig: Input.file("tsconfig.json"),
        buildMode: false,
        incremental: false,
        env,
        cwd: "packages/alpha"
      })],
    ["Dprint", (env: Record<string, string>) =>
      Dprint({
        sources: [Input.glob("src/**/*.ts")],
        deps: [],
        config: Input.file("dprint.json"),
        fix: false,
        env,
        cwd: "packages/alpha"
      })],
    ["EsLint", (env: Record<string, string>) =>
      EsLint({
        sources: [Input.glob("src/**/*.ts")],
        deps: [],
        configs: [Input.file("eslint.config.js")],
        maxWarnings: 0,
        fix: false,
        env,
        cwd: "packages/alpha"
      })],
    ["BiomeCheck", (env: Record<string, string>) =>
      BiomeCheck({
        sources: [Input.glob("src/**/*.ts")],
        deps: [],
        config: Input.file("biome.json"),
        lint: true,
        format: true,
        unsafe: false,
        env,
        cwd: "packages/alpha"
      })],
    ["DepsLint", (env: Record<string, string>) =>
      DepsLint({
        packageJson: Input.file("package.json"),
        sources: [Input.glob("src/**/*.ts")],
        deps: [],
        tool: "knip",
        ignoreDependencies: [],
        ignoreBinaries: [],
        env,
        cwd: "packages/alpha"
      })],
    ["PackageLint", (env: Record<string, string>) =>
      PackageLint({
        packageJson: Input.file("package.json"),
        artifacts: [Input.glob("dist/**/*")],
        deps: [],
        strict: true,
        pack: false,
        attw: true,
        env,
        cwd: "packages/alpha"
      })]
  ] as const

  it.each(declarations)("%s defaults its environment to empty", (_name, declare) => {
    const target = declare({})
    expect((Target.metadata(target).attrs as { readonly env: Record<string, string> }).env).toEqual({})
    for (const planned of plannedEnvironments(target)) expect(planned).toEqual({})
  })

  it.each(declarations)("%s threads its environment into every tool run", (_name, declare) => {
    const planned = plannedEnvironments(declare({ FC_SEED: "7" }))
    expect(planned.length).toBeGreaterThan(0)
    for (const environment of planned) expect(environment).toEqual({ FC_SEED: "7" })
  })
})

describe("the declared environment is key material", () => {
  /**
   * Two `Typecheck` targets that differ in nothing but `env`, planned through
   * the planner the CLI runs, so the compared value is the key the executor
   * would cache on. The third target repeats the first declaration: a rule
   * whose key moved for any other reason would show up here as a mismatch
   * between two identical declarations.
   */
  it("gives two targets differing only in env different keys", async () => {
    const rulesModule = NodePath.resolve(import.meta.dirname, "../src/Typecheck.ts")
    const inputModule = NodePath.resolve(import.meta.dirname, "../src/Input.ts")
    await write("package.json", `${JSON.stringify({ name: "fixture", private: true })}\n`)
    await write("BUILD.ts", "export const root = 1\n")
    await write("packages/alpha/package.json", `${JSON.stringify({ name: "alpha", private: true })}\n`)
    await write("packages/alpha/tsconfig.json", `${JSON.stringify({ compilerOptions: { strict: true } })}\n`)
    await write("packages/alpha/src/index.ts", "export const alpha = 1\n")
    await write(
      "packages/alpha/BUILD.ts",
      [
        `import { Typecheck } from "${rulesModule}"`,
        `import * as Input from "${inputModule}"`,
        "",
        "const declare = (env) => ({",
        "  srcs: [Input.glob(\"src/**/*.ts\")],",
        "  deps: [],",
        "  tsconfig: Input.file(\"tsconfig.json\"),",
        "  buildMode: false,",
        "  incremental: false,",
        "  env,",
        "  cwd: \"packages/alpha\"",
        "})",
        "",
        "export const seedOne = Typecheck(declare({ FC_SEED: \"1\" }))",
        "export const seedTwo = Typecheck(declare({ FC_SEED: \"2\" }))",
        "export const seedOneAgain = Typecheck(declare({ FC_SEED: \"1\" }))",
        ""
      ].join("\n")
    )

    const workspace = await Workspace.make(root, root, { cacheDirectory: ".flows" })
    const plan = await Planner.make(workspace, "build", "//...")
    const keyOf = (label: string): string => {
      const planned = plan.targets.find((entry) => entry.label === label)
      if (planned === undefined) throw new Error(`the plan has no target ${label}`)
      return planned.keyPreview
    }

    const one = keyOf("//packages/alpha:seedOne")
    const two = keyOf("//packages/alpha:seedTwo")
    const again = keyOf("//packages/alpha:seedOneAgain")

    // Printed so a reviewer reads the two keys the assertion compares.
    console.log(`FC_SEED=1 ${one}\nFC_SEED=2 ${two}`)
    expect(one).not.toBe(two)
    expect(again).toBe(one)
  })
})

describe("the declared environment reaches the child process", () => {
  /**
   * The payload is the one `Typecheck` planned, carried unchanged except for
   * argv: the scratch workspace has no TypeScript install, and the claim under
   * test is that the declared value survives the plan and the spawn, not that
   * `tsc` reads it.
   */
  it("hands the declared value to the spawned tool", async () => {
    const target = Typecheck({
      srcs: [Input.glob("src/**/*.ts")],
      deps: [],
      tsconfig: Input.file("tsconfig.json"),
      buildMode: false,
      incremental: false,
      env: { FC_SEED: "7" },
      cwd: "."
    })
    const [payload] = execPayloads(target)
    if (payload === undefined) throw new Error("Typecheck planned no exec step")

    const result = await Effect.runPromise(Exec.run({ workspaceRoot: root }, {
      ...payload,
      argv: ["node", "-e", "process.stdout.write(process.env.FC_SEED ?? \"unset\")"],
      secrets: [],
      expectedExitCodes: [0],
      timeoutMs: Exec.defaultTimeoutMs
    }))

    expect(result.stdout).toBe("7")
  })
})
