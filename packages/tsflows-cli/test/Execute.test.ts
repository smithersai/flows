/**
 * End-to-end execution over real BUILD.ts files in a temporary workspace.
 *
 * Three properties are pinned here, all of which were once only asserted by
 * reading the code:
 *
 * 1. `build`, `test`, `lint`, `docs`, and `ci` EXECUTE selected targets — over
 *    `//...` and over an exact label — instead of printing a plan. The proof
 *    is a side effect on disk that only running the target's Flow produces.
 * 2. A failing target fails the run with a non-zero exit status and BLOCKS its
 *    dependents, which report `skipped` rather than running against a
 *    dependency that never succeeded.
 * 3. A checking verb does not mutate the working tree. Drifted generated files
 *    fail the run, byte for byte unchanged.
 */
import { spawn } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Executor from "../src/Executor.ts"
import * as Planner from "../src/Planner.ts"
import { Workspace } from "../src/Workspace.ts"

const rulesModule = NodePath.resolve(import.meta.dirname, "../../tsflows-rules/src/index.ts")
const schemaModule = import.meta.resolve("effect/Schema")
const cli = NodePath.resolve(import.meta.dirname, "../src/main.js")

let root: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const read = (relative: string): Promise<string> => Fs.readFile(NodePath.join(root, relative), "utf8")

const open = async (): Promise<Workspace> => Workspace.make(root, root, { cacheDirectory: ".flows" })

/** Plans and executes one verb, exactly as the CLI command does. */
const run = async (
  verb: "build" | "test" | "lint" | "run",
  pattern: string
): Promise<Executor.Summary> => {
  const workspace = await open()
  const plan = await Planner.make(workspace, verb, pattern)
  return Executor.execute({
    workspace,
    verb,
    pattern,
    targets: plan.targets,
    jobs: 4,
    readCache: false,
    log: () => {}
  })
}

/** Plans every CI kind over one pattern and executes the merged graph. */
const runCi = async (pattern: string): Promise<Executor.Summary> => {
  const workspace = await open()
  const plans = []
  for (const kind of ["lint", "build", "test", "docs"] as const) {
    try {
      plans.push(await Planner.make(workspace, kind, pattern))
    } catch (cause) {
      if (!String(cause).includes(`does not support the ${kind} verb`)) throw cause
    }
  }
  const merged = Executor.mergePlans(plans)
  return Executor.execute({
    workspace,
    verb: "ci",
    pattern,
    targets: merged.targets,
    jobs: 4,
    readCache: false,
    log: () => {}
  })
}

const status = (summary: Executor.Summary, label: string): string | undefined =>
  summary.results.find((entry) => entry.label === label)?.status

const invoke = (args: ReadonlyArray<string>): Promise<{ readonly code: number | null; readonly output: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => output += chunk)
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => output += chunk)
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, output }))
  })

beforeEach(async () => {
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "tsflows-execute-"))
  await write("package.json", `${JSON.stringify({ name: "fixture", private: true }, undefined, 2)}\n`)
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("targets execute", () => {
  /**
   * Two packages, each generating a manifest, plus an `Exec` target that
   * touches a file. A generated file appearing on disk and a shell command
   * having run are both observations no plan print can fake.
   */
  const generatorWorkspace = async (): Promise<void> => {
    await write("BUILD.ts", "export const root = 1\n")
    for (const name of ["alpha", "beta"]) {
      await write(
        `packages/${name}/package.json`,
        `${JSON.stringify({ name, version: "1.0.0" }, undefined, 2)}\n`
      )
      await write(
        `packages/${name}/BUILD.ts`,
        `import { PackageJson } from "${rulesModule}"\n` +
          `export const packageJson = PackageJson({\n` +
          `  name: "${name}",\n` +
          `  version: "1.0.0",\n` +
          `  description: "${name}"\n` +
          `})\n`
      )
    }
  }

  it("executes every generator selected by //... and writes the files", async () => {
    await generatorWorkspace()
    const summaries = [
      await run("run", "//packages/alpha:packageJsonWrite"),
      await run("run", "//packages/beta:packageJsonWrite")
    ]

    expect(summaries.every((summary) => summary.ok), JSON.stringify(summaries)).toBe(true)
    expect(summaries.reduce((count, summary) => count + summary.counts.ran, 0)).toBe(2)
    expect(summaries.reduce((count, summary) => count + summary.counts.failed, 0)).toBe(0)
    // The observable effect of actually running the targets.
    expect(JSON.parse(await read("packages/alpha/package.json")).description).toBe("alpha")
    expect(JSON.parse(await read("packages/beta/package.json")).description).toBe("beta")
  })

  it("executes only the target named by an exact label", async () => {
    await generatorWorkspace()
    const summary = await run("run", "//packages/alpha:packageJsonWrite")

    expect(summary.ok).toBe(true)
    expect(summary.results.map((entry) => entry.label)).toEqual(["//packages/alpha:packageJsonWrite"])
    expect(await read("packages/alpha/package.json")).toContain("\"description\": \"alpha\"")
    expect(await read("packages/beta/package.json")).not.toContain("description")
  })

  it("runs a real command through the exec action", async () => {
    await write("BUILD.ts", "export const root = 1\n")
    await write(
      "packages/tool/BUILD.ts",
      `import { Exec, Rule } from "${rulesModule}"\n` +
        `import * as Schema from "${schemaModule}"\n` +
        `export const touch = Rule.make("Touch", {\n` +
        `  attrs: Schema.Struct({ name: Schema.NonEmptyString }),\n` +
        `  kinds: ["build"],\n` +
        `  success: Exec.Result,\n` +
        `  error: Exec.ExecError,\n` +
        `  implementation: (attrs) => Rule.runTool({ cwd: ".", argv: ["node", "-e", \`require('fs').writeFileSync('ran-\${attrs.name}.txt','ok')\`] })\n` +
        `})({ name: "tool" })\n`
    )
    const summary = await run("build", "//...")

    expect(summary.ok).toBe(true)
    expect(await read("ran-tool.txt")).toBe("ok")
  })

  it("fails the run and blocks dependents when a target fails", async () => {
    await write("BUILD.ts", "export const root = 1\n")
    await write(
      "packages/base/BUILD.ts",
      `import { Exec, Rule } from "${rulesModule}"\n` +
        `import * as Schema from "${schemaModule}"\n` +
        `export const failing = Rule.make("Failing", {\n` +
        `  attrs: Schema.Struct({}),\n` +
        `  kinds: ["build"],\n` +
        `  success: Exec.Result,\n` +
        `  error: Exec.ExecError,\n` +
        `  implementation: () => Rule.runTool({ cwd: ".", argv: ["node", "-e", "process.exit(3)"] })\n` +
        `})({})\n`
    )
    await write(
      "packages/dependent/BUILD.ts",
      `import { Exec, Rule } from "${rulesModule}"\n` +
        `import * as Schema from "${schemaModule}"\n` +
        `import { failing } from "../base/BUILD.ts"\n` +
        `export const downstream = Rule.make("Downstream", {\n` +
        `  attrs: Schema.Struct({ deps: Schema.Array(Rule.Target) }),\n` +
        `  kinds: ["build"],\n` +
        `  success: Exec.Result,\n` +
        `  error: Exec.ExecError,\n` +
        `  implementation: () => Rule.runTool({ cwd: ".", argv: ["node", "-e", \`require('fs').writeFileSync('downstream-ran.txt','ok')\`] })\n` +
        `})({ deps: [failing] })\n`
    )
    const summary = await run("build", "//...")
    expect(summary.ok).toBe(false)
    expect(summary.counts.failed).toBe(1)
    expect(status(summary, "//packages/base:failing")).toBe("failed")
    // Blocked, not run: the dependent never executed against a dependency
    // that did not succeed.
    expect(status(summary, "//packages/dependent:downstream")).toBe("skipped")
    await expect(read("downstream-ran.txt")).rejects.toThrow()
  })

  it("propagates failure through the real CLI process and still blocks dependents", async () => {
    await write("BUILD.ts", "export const root = 1\n")
    await write(
      "packages/base/BUILD.ts",
      `import { Exec, Rule } from "${rulesModule}"\n` +
        `import * as Schema from "${schemaModule}"\n` +
        `export const failing = Rule.make("ProcessFailing", {\n` +
        `  attrs: Schema.Struct({}), kinds: ["build"], success: Exec.Result, error: Exec.ExecError,\n` +
        `  implementation: () => Rule.runTool({ cwd: ".", argv: ["node", "-e", "process.exit(7)"] })\n` +
        `})({})\n`
    )
    await write(
      "packages/dependent/BUILD.ts",
      `import { Exec, Rule } from "${rulesModule}"\n` +
        `import * as Schema from "${schemaModule}"\n` +
        `import { failing } from "../base/BUILD.ts"\n` +
        `export const downstream = Rule.make("ProcessDependent", {\n` +
        `  attrs: Schema.Struct({ deps: Schema.Array(Rule.Target) }), kinds: ["build"],\n` +
        `  success: Exec.Result, error: Exec.ExecError,\n` +
        `  implementation: () => Rule.runTool({ cwd: ".", argv: ["node", "-e", ` +
        `"require('node:fs').writeFileSync('process-dependent-ran','bad')"] })\n` +
        `})({ deps: [failing] })\n`
    )

    const result = await invoke(["build", "//..."])
    expect(result.code).not.toBe(0)
    expect(result.output).toContain("//packages/base:failing")
    await expect(Fs.stat(NodePath.join(root, "process-dependent-ran"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})

describe("checking verbs do not mutate the working tree", () => {
  const driftedWorkspace = async (): Promise<void> => {
    await write("BUILD.ts", "export const root = 1\n")
    await write("packages/alpha/package.json", `${JSON.stringify({ name: "alpha" }, undefined, 2)}\n`)
    await write(
      "packages/alpha/BUILD.ts",
      `import { PackageJson } from "${rulesModule}"\n` +
        `export const packageJson = PackageJson({\n` +
        `  name: "alpha",\n` +
        `  version: "1.0.0",\n` +
        `  description: "alpha"\n` +
        `})\n`
    )
  }

  it("lint fails on drift and leaves the file byte for byte unchanged", async () => {
    await driftedWorkspace()
    const before = await read("packages/alpha/package.json")
    const summary = await run("lint", "//...")

    expect(summary.ok).toBe(false)
    expect(status(summary, "//packages/alpha:packageJsonCheck")).toBe("failed")
    expect(await read("packages/alpha/package.json")).toBe(before)
  })

  it("ci fails on drift and leaves the file byte for byte unchanged", async () => {
    await driftedWorkspace()
    const before = await read("packages/alpha/package.json")
    const summary = await runCi("//...")

    expect(summary.ok).toBe(false)
    expect(await read("packages/alpha/package.json")).toBe(before)
  })

  it("build does not select either manifest sync target", async () => {
    await driftedWorkspace()
    const before = await read("packages/alpha/package.json")
    const summary = await run("build", "//...")

    expect(summary.ok).toBe(true)
    expect(await read("packages/alpha/package.json")).toBe(before)
  })

  it("ci selects the check target and never the separate write target", async () => {
    await driftedWorkspace()
    const before = await read("packages/alpha/package.json")
    const summary = await runCi("//...")

    expect(summary.ok).toBe(false)
    expect(status(summary, "//packages/alpha:packageJsonCheck")).toBe("failed")
    expect(await read("packages/alpha/package.json")).toBe(before)
  })

  it("ci executes documentation parity targets", async () => {
    await write("BUILD.ts", "export const root = 1\n")
    await write("packages/thin/README.md", "# thin\n\nToo short.\n")
    await write(
      "packages/thin/BUILD.ts",
      `import { DocsParity, file } from "${rulesModule}"\n` +
        `export const docs = DocsParity({ readme: file("README.md"), deps: [], cwd: "packages/thin" })\n`
    )

    const summary = await runCi("//...")

    expect(summary.ok).toBe(false)
    expect(status(summary, "//packages/thin:docs")).toBe("failed")
  })
})

describe("the CI workflow contract", () => {
  const workflow = [
    "name: CI",
    "on:",
    "  push:",
    "    branches: [main]",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: pnpm install --frozen-lockfile",
    "      - name: Typecheck",
    "        run: pnpm run check",
    "      - name: Lint",
    "        run: pnpm run lint",
    "  rust:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: cargo test --locked",
    ""
  ].join("\n")

  const contractWorkspace = async (): Promise<void> => {
    await write("BUILD.ts", "export const root = 1\n")
    await write(
      "packages/pipeline/BUILD.ts",
      `import { GithubCiGen } from "${rulesModule}"\n` +
        `export const ci = GithubCiGen({\n` +
        `  workflowName: "CI",\n` +
        `  pushBranches: ["main"],\n` +
        `  pullRequest: true,\n` +
        `  workflowDispatch: false,\n` +
        `  cancelInProgress: true,\n` +
        `  jobs: [],\n` +
        `  requiredJobs: ["test", "rust"],\n` +
        `  gates: [\n` +
        `    { name: "typecheck", command: "pnpm run check", job: "test" },\n` +
        `    { name: "lint", command: "pnpm run lint", job: "test" },\n` +
        `    { name: "rust test", command: "cargo test --locked", job: "rust" }\n` +
        `  ],\n` +
        `  output: ".github/workflows/ci.yml"\n` +
        `})\n`
    )
  }

  it("passes while the workflow still runs every declared gate", async () => {
    await contractWorkspace()
    await write(".github/workflows/ci.yml", workflow)
    const summary = await run("lint", "//...")

    expect(summary.ok).toBe(true)
    expect(status(summary, "//packages/pipeline:ci")).toBe("ran")
  })

  it("fails, without rewriting the file, when a gate is deleted", async () => {
    await contractWorkspace()
    const stripped = workflow.replace("      - name: Lint\n        run: pnpm run lint\n", "")
    await write(".github/workflows/ci.yml", stripped)
    const summary = await run("lint", "//...")

    expect(summary.ok).toBe(false)
    expect(summary.results[0]!.error).toContain("lint")
    // The whole point: a workflow the contract rejects is reported, never
    // replaced with generated output.
    expect(await read(".github/workflows/ci.yml")).toBe(stripped)
  })

  it("fails when a required job is deleted", async () => {
    await contractWorkspace()
    const withoutRust = workflow.slice(0, workflow.indexOf("  rust:"))
    await write(".github/workflows/ci.yml", withoutRust)
    const summary = await run("lint", "//...")

    expect(summary.ok).toBe(false)
    expect(summary.results[0]!.error).toContain("rust")
  })

  it("fails when the workflow file is missing entirely", async () => {
    await contractWorkspace()
    const summary = await run("lint", "//...")

    expect(summary.ok).toBe(false)
  })
})

/**
 * The generating half of the same rule. Contract mode is what a repository
 * with a hand-written pipeline uses; `write` is the path that owns the file,
 * and the only proof it is safe is a workflow on disk that runs the declared
 * install, then the workspace-pinned CLI, and satisfies its own gates.
 */
describe("the CI workflow generator", () => {
  const writingWorkspace = async (mode: string): Promise<void> => {
    await write("BUILD.ts", "export const root = 1\n")
    await write(
      "packages/pipeline/BUILD.ts",
      `import { GithubCiGen } from "${rulesModule}"\n` +
        `export const ci = GithubCiGen({\n` +
        `  workflowName: "CI",\n` +
        `  pushBranches: ["main"],\n` +
        `  pullRequest: true,\n` +
        `  workflowDispatch: false,\n` +
        `  cancelInProgress: true,\n` +
        `  install: "pnpm install --frozen-lockfile",\n` +
        `  requiredJobs: ["test"],\n` +
        `  gates: [{ name: "typecheck", command: "pnpm run check", job: "test" }],\n` +
        `  jobs: [{\n` +
        `    id: "test",\n` +
        `    runsOn: "ubuntu-latest",\n` +
        `    steps: [\n` +
        `      { uses: "actions/checkout@v4" },\n` +
        `      { run: "pnpm install --frozen-lockfile" },\n` +
        `      { name: "Typecheck", run: "pnpm run check" }\n` +
        `    ]\n` +
        `  }],\n` +
        `  output: ".github/workflows/generated.yml",\n` +
        `  mode: "${mode}"\n` +
        `})\n`
    )
  }

  it("writes a workflow that installs from the lockfile and runs the pinned CLI", async () => {
    await writingWorkspace("write")
    const summary = await run("build", "//...")

    expect(summary.ok).toBe(true)
    const generated = await read(".github/workflows/generated.yml")
    const install = generated.indexOf("- run: pnpm install --frozen-lockfile")
    // The pattern is rendered as one single-quoted shell word, so the runner's
    // shell cannot expand or re-split it.
    const execute = generated.indexOf("- run: pnpm exec tsflows ci '//...'")
    expect(install).toBeGreaterThan(-1)
    // The workspace-pinned CLI, after the install that pinned it, and nothing
    // fetched from a registry.
    expect(execute).toBeGreaterThan(install)
    expect(generated).not.toContain("dlx")
  })

  it("lints the workflow it just wrote, and reports a hand edit without repairing it", async () => {
    await writingWorkspace("write")
    await run("build", "//...")
    const generated = await read(".github/workflows/generated.yml")

    // The `lint` form of a writing target is the checking form.
    expect((await run("lint", "//...")).ok).toBe(true)

    const edited = generated.replace("        run: pnpm run check\n", "        run: echo skipped\n")
    await write(".github/workflows/generated.yml", edited)
    const drifted = await run("lint", "//...")

    expect(drifted.ok).toBe(false)
    expect(await read(".github/workflows/generated.yml")).toBe(edited)
  })

  it("fails the run, without writing, when the declaration is one write mode refuses", async () => {
    await write("BUILD.ts", "export const root = 1\n")
    await write(
      "packages/pipeline/BUILD.ts",
      `import { GithubCiGen } from "${rulesModule}"\n` +
        `export const ci = GithubCiGen({\n` +
        `  workflowName: "CI",\n` +
        `  pushBranches: ["main"],\n` +
        `  pullRequest: true,\n` +
        `  workflowDispatch: false,\n` +
        `  cancelInProgress: true,\n` +
        `  requiredJobs: [],\n` +
        `  gates: [],\n` +
        // No step performs the declared install, so the pinned CLI would not
        // be in the tree when the generated step runs it.
        `  jobs: [{ id: "test", runsOn: "ubuntu-latest", steps: [{ run: "echo hello" }] }],\n` +
        `  output: ".github/workflows/generated.yml",\n` +
        `  mode: "write"\n` +
        `})\n`
    )
    const result = await invoke(["build", "//..."])

    expect(result.code).not.toBe(0)
    expect(result.output).toContain("no step runs the declared install")
    await expect(read(".github/workflows/generated.yml")).rejects.toThrow()
  })
})
