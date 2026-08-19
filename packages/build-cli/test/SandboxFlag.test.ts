/**
 * D15: the sandbox escape hatch and the irreversible-exec gate.
 *
 * Five properties are pinned here:
 *
 * 1. `--dangerously-no-sandbox` is accepted and a bare `--no-sandbox` is not.
 *    incur parses any leading `--no-` as boolean negation, so a schema key
 *    named `sandbox` would silently ship a quiet `--no-sandbox` beside the
 *    loud flag. The rejection is the regression guard for that trap.
 * 2. The per-target `sandbox` metadata field is honoured: under the default
 *    `declared` policy an opted-in target runs projected and every other
 *    target runs against the workspace, and the `off` policy — what the loud
 *    flag resolves to — overrides the opt-in.
 * 3. An un-sandboxed target is still cached: a target run under the flag's
 *    policy produces a cache entry and a second run consumes it.
 * 4. The sandbox mode is key material: a sandboxed and an un-sandboxed run of
 *    the same target never share an entry.
 * 5. The irreversible exec action resolves under the `run` verb and is
 *    refused under build, test, lint, and docs.
 */
import type * as Config from "@smthrs/targets/Config"
import { spawn } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Executor from "../src/Executor.ts"
import * as Planner from "../src/Planner.ts"
import { Workspace } from "../src/Workspace.ts"

const rulesModule = NodePath.resolve(import.meta.dirname, "../../targets/src/Smithers.ts")
const changesetsModule = NodePath.resolve(import.meta.dirname, "../../targets/src/Changesets.ts")
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
  verb: "build" | "test" | "lint" | "docs" | "run",
  pattern: string,
  options: {
    readonly sandbox?: Config.Sandbox | undefined
    readonly readCache?: boolean | undefined
  } = {}
): Promise<Executor.Summary> => {
  const workspace = await open()
  const plan = await Planner.make(workspace, verb, pattern)
  return Executor.execute({
    workspace,
    verb,
    pattern,
    targets: plan.targets,
    jobs: 1,
    readCache: options.readCache ?? false,
    sandbox: options.sandbox,
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

/** The exec body both probe targets share: read a file no target declares. */
const readUndeclared =
  "implementation: () => Target.runTool({ cwd: \".\", argv: [\"node\", \"-e\", \"require('node:fs').readFileSync('undeclared.txt')\"] })"

/**
 * Two probe targets that read a file neither declares. `readsProjected` opts
 * into projection through the per-target `sandbox` metadata field;
 * `readsWorkspace` does not.
 */
const sandboxFixture = async (): Promise<void> => {
  await write("BUILD.ts", "export const root = 1\n")
  await write("undeclared.txt", "not an input of any target\n")
  await write(
    "packages/probe/BUILD.ts",
    `import { Exec, Target } from "${rulesModule}"\n` +
      `import * as Schema from "${schemaModule}"\n` +
      `export const readsWorkspace = Target.make("ReadsWorkspace", {\n` +
      `  attrs: Schema.Struct({}),\n` +
      `  kinds: ["build"],\n` +
      `  success: Exec.Result,\n` +
      `  error: Exec.ExecError,\n` +
      `  ${readUndeclared}\n` +
      `})({})\n` +
      `export const readsProjected = Target.make("ReadsProjected", {\n` +
      `  attrs: Schema.Struct({}),\n` +
      `  kinds: ["build"],\n` +
      `  success: Exec.Result,\n` +
      `  error: Exec.ExecError,\n` +
      `  sandbox: true,\n` +
      `  ${readUndeclared}\n` +
      `})({})\n`
  )
}

/** One cacheable target whose body behaves identically under either mode. */
const cacheFixture = async (): Promise<void> => {
  await write("BUILD.ts", "export const root = 1\n")
  await write(
    "packages/probe/BUILD.ts",
    `import { Exec, Target } from "${rulesModule}"\n` +
      `import * as Schema from "${schemaModule}"\n` +
      `export const cacheable = Target.make("CacheableProbe", {\n` +
      `  attrs: Schema.Struct({}),\n` +
      `  kinds: ["build"],\n` +
      `  success: Exec.Result,\n` +
      `  error: Exec.ExecError,\n` +
      `  cache: true,\n` +
      `  implementation: () => Target.runTool({ cwd: ".", argv: ["node", "-e", "console.log('ok')"] })\n` +
      `})({})\n`
  )
}

/** One target whose only step is the irreversible exec action. */
const irreversibleFixture = async (): Promise<void> => {
  await write("BUILD.ts", "export const root = 1\n")
  await write(
    "packages/release/BUILD.ts",
    `import { Exec, Target } from "${rulesModule}"\n` +
      `import { ExecIrreversible } from "${changesetsModule}"\n` +
      `import * as Schema from "${schemaModule}"\n` +
      `export const mutation = Target.make("IrreversibleProbe", {\n` +
      `  attrs: Schema.Struct({}),\n` +
      `  kinds: ["build", "test", "lint", "docs", "run"],\n` +
      `  success: Exec.Result,\n` +
      `  error: Exec.ExecError,\n` +
      `  implementation: () => ExecIrreversible.call({\n` +
      `    cwd: ".",\n` +
      `    argv: ["node", "-e", "require('node:fs').writeFileSync('irreversible-ran.txt', 'ok')"]\n` +
      `  })\n` +
      `})({})\n`
  )
}

beforeEach(async () => {
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-sandbox-flag-"))
  await write("package.json", `${JSON.stringify({ name: "fixture", private: true }, undefined, 2)}\n`)
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("the loud CLI flag", () => {
  it("rejects a bare --no-sandbox", async () => {
    await sandboxFixture()
    const { code, output } = await invoke(["build", "//...", "--no-sandbox"])

    expect(code).not.toBe(0)
    expect(output).toContain("Unknown flag: --no-sandbox")
  })

  it("accepts --dangerously-no-sandbox and turns projection off for the run", async () => {
    await sandboxFixture()
    // Control: under the default declared policy the opted-in target runs
    // projected, cannot read the undeclared file, and fails.
    const control = await invoke(["build", "//..."])
    expect(control.code).toBe(1)

    const flagged = await invoke(["build", "//...", "--dangerously-no-sandbox"])
    expect(flagged.output).not.toContain("Unknown flag")
    expect(flagged.code).toBe(0)
  })
})

describe("the per-target sandbox field", () => {
  it("projects an opted-in target and leaves the rest on the workspace", async () => {
    await sandboxFixture()
    const summary = await run("build", "//...", {
      sandbox: { projection: "declared", environment: [] }
    })

    expect(status(summary, "//packages/probe:readsWorkspace")).toBe("ran")
    // Projected: the scratch root holds exactly the declared inputs, which are
    // empty, so the undeclared read fails there.
    expect(status(summary, "//packages/probe:readsProjected")).toBe("failed")
  })

  it("lets the off policy override a target's opt-in", async () => {
    await sandboxFixture()
    const summary = await run("build", "//...", {
      sandbox: { projection: "off", environment: [] }
    })

    expect(summary.ok).toBe(true)
    expect(status(summary, "//packages/probe:readsProjected")).toBe("ran")
  })
})

describe("caching under the escape hatch", () => {
  it("still caches a target run un-sandboxed", async () => {
    await cacheFixture()
    const policy = { projection: "off", environment: [] } as const
    const first = await run("build", "//...", { sandbox: policy, readCache: true })
    const second = await run("build", "//...", { sandbox: policy, readCache: true })

    expect(status(first, "//packages/probe:cacheable")).toBe("ran")
    expect(status(second, "//packages/probe:cacheable")).toBe("hit")
  })

  it("never shares an entry between a sandboxed and an un-sandboxed run", async () => {
    await cacheFixture()
    const off = { projection: "off", environment: [] } as const
    const forced = { projection: "forced", environment: [] } as const
    const label = "//packages/probe:cacheable"

    expect(status(await run("build", "//...", { sandbox: off, readCache: true }), label)).toBe("ran")
    // A projected run must not consume the workspace-mode entry.
    expect(status(await run("build", "//...", { sandbox: forced, readCache: true }), label)).toBe("ran")
    // Each mode replays its own entry.
    expect(status(await run("build", "//...", { sandbox: forced, readCache: true }), label)).toBe("hit")
    expect(status(await run("build", "//...", { sandbox: off, readCache: true }), label)).toBe("hit")
  })
})

describe("the irreversible-exec gate", () => {
  it("resolves the action under the run verb", async () => {
    await irreversibleFixture()
    const summary = await run("run", "//packages/release:mutation")

    expect(summary.ok).toBe(true)
    expect(status(summary, "//packages/release:mutation")).toBe("ran")
    expect(await read("irreversible-ran.txt")).toBe("ok")
  })

  it.each(["build", "test", "lint", "docs"] as const)("refuses the action under the %s verb", async (verb) => {
    await irreversibleFixture()
    const summary = await run(verb, "//packages/release:mutation")

    expect(summary.ok).toBe(false)
    expect(status(summary, "//packages/release:mutation")).toBe("failed")
    // Refused, not executed: the irreversible step never ran. Report rendering
    // collapses every exec failure to "target failed", so the absent side
    // effect is the assertion that distinguishes a refusal from a bad run.
    await expect(read("irreversible-ran.txt")).rejects.toThrow()
  })
})
