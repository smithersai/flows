/**
 * Bun coverage targets.
 *
 * A coverage target either gates on explicit thresholds or names why it does
 * not. The tests assert the rejection at declaration time and the argv the
 * first step records. The two-step plan (run, then threshold gate) is only
 * visible after the planner builds the graph, because the gate is an
 * `andThen` continuation, so those assertions plan a scratch workspace laid
 * out like the smithers packages through the planner the CLI runs.
 */
import { Graph } from "@smthrs/flow"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Planner from "../../build-cli/src/Planner.ts"
import { Workspace } from "../../build-cli/src/Workspace.ts"
import { BunTest } from "../src/BunTest.ts"
import { BunTestCoverage } from "../src/BunTestCoverage.ts"
import * as Exec from "../src/Exec.ts"
import * as Input from "../src/Input.ts"
import * as Target from "../src/Target.ts"
import "./toolchain.ts"

let root: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-buncoverage-")))
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

/**
 * Every exec payload in the fully built graph, including the payloads behind
 * `andThen` continuations, which the raw body walk cannot see. This is the
 * elaboration the executor runs.
 */
const graphPayloads = (target: Target.AnyTarget): ReadonlyArray<Exec.Payload> =>
  Graph.nodes(Graph.build(target as never, Target.metadata(target).attrs))
    .filter((node) => node.kind === "ActionCall")
    .map((node) => node.payload as Exec.Payload)
    .filter((payload) => Array.isArray(payload.argv))

const thresholds = { lines: 40, functions: 50, branches: 0, statements: 0 }

const declareCoverage = (extra: Partial<Parameters<typeof BunTestCoverage>[0]> = {}) =>
  BunTestCoverage({
    tests: [Input.file("tests/a.test.ts"), Input.file("tests/b.test.ts")],
    sources: [Input.glob("src/**/*.ts")],
    deps: [],
    preload: null,
    timeoutMs: 5000,
    maxConcurrency: 20,
    isolate: false,
    pathIgnorePatterns: [],
    reporter: null,
    reporterOutfile: null,
    coverageDir: "coverage",
    coverageReporter: "lcov",
    thresholds,
    profile: "library",
    unsupportedReason: null,
    cwd: "packages/alpha",
    ...extra
  })

describe("BunTestCoverage requires thresholds or a reason", () => {
  it("rejects a target that omits both thresholds and unsupportedReason", () => {
    expect(() => declareCoverage({ thresholds: null, unsupportedReason: null, profile: null }))
      .toThrow(/unsupportedReason/)
  })

  it("accepts an unsupported package that names why", () => {
    const target = declareCoverage({
      thresholds: null,
      profile: null,
      unsupportedReason: "Covered by the normal test and typecheck jobs, not coverage thresholds."
    })
    expect(Target.isTarget(target)).toBe(true)
  })

  it("rejects thresholds against the text reporter, which writes no lcov", () => {
    expect(() => declareCoverage({ coverageReporter: "text" })).toThrow(/lcov/)
  })

  it("rejects a junit reporter without the file it writes to", () => {
    expect(() => declareCoverage({ reporter: "junit" })).toThrow(/reporterOutfile/)
  })
})

describe("BunTestCoverage plans a coverage run", () => {
  it("is a cacheable test-kind target", () => {
    expect(BunTestCoverage.kinds).toEqual(["test"])
    expect(Target.metadata(declareCoverage()).cacheable).toBe(true)
  })

  it("runs bun test with coverage flags before the positional file list", () => {
    const [payload] = execPayloads(declareCoverage())
    if (payload === undefined) throw new Error("the rule planned no exec step")
    expect(payload.argv.slice(0, 4)).toEqual(["pnpm", "exec", "bun", "test"])
    expect(payload.argv).toContain("--coverage")
    expect(payload.argv).toContain("--coverage-reporter=lcov")
    expect(payload.argv).toContain("--coverage-dir=coverage")
    expect(payload.argv.slice(-2)).toEqual(["tests/a.test.ts", "tests/b.test.ts"])
    expect(payload.argv.indexOf("--coverage")).toBeLessThan(payload.argv.indexOf("tests/a.test.ts"))
  })

  it("gates on the lcov report in a second step when thresholds are declared", () => {
    const payloads = graphPayloads(declareCoverage())
    expect(payloads).toHaveLength(2)
    const gate = payloads[1]
    if (gate === undefined) throw new Error("the rule planned no gate step")
    expect(gate.argv.slice(0, 4)).toEqual(["pnpm", "exec", "bun", "-e"])
    expect(gate.argv).toContain("coverage/lcov.info")
    expect(gate.argv.slice(-4)).toEqual(["40", "50", "0", "0"])
  })

  it("plans no gate for an unsupported package", () => {
    const payloads = graphPayloads(
      declareCoverage({
        thresholds: null,
        profile: null,
        unsupportedReason: "Bun coverage cannot instrument the fault matrix."
      })
    )
    expect(payloads).toHaveLength(1)
    const [run] = payloads
    if (run === undefined) throw new Error("the rule planned no exec step")
    expect(run.argv).toContain("--coverage")
  })

  it("keys on thresholds, planning a smithers package layout through the CLI planner", async () => {
    const rulesModule = NodePath.resolve(import.meta.dirname, "../src/BunTestCoverage.ts")
    const inputModule = NodePath.resolve(import.meta.dirname, "../src/Input.ts")
    await write("package.json", `${JSON.stringify({ name: "fixture", private: true })}\n`)
    await write("BUILD.ts", "export const root = 1\n")
    await write("packages/alpha/package.json", `${JSON.stringify({ name: "alpha", private: true })}\n`)
    await write("packages/alpha/src/index.ts", "export const alpha = 1\n")
    await write("packages/alpha/tests/a.test.ts", "// a\n")
    await write("packages/alpha/tests/b.test.ts", "// b\n")
    await write(
      "packages/alpha/BUILD.ts",
      [
        `import { BunTestCoverage } from "${rulesModule}"`,
        `import * as Input from "${inputModule}"`,
        "",
        "const shared = {",
        "  sources: [Input.glob(\"src/**/*.ts\")],",
        "  deps: [],",
        "  preload: null,",
        "  timeoutMs: 5000,",
        "  maxConcurrency: 1,",
        "  isolate: false,",
        "  pathIgnorePatterns: [],",
        "  reporter: null,",
        "  reporterOutfile: null,",
        "  coverageDir: \"coverage\",",
        "  coverageReporter: \"lcov\",",
        "  unsupportedReason: null,",
        "  cwd: \"packages/alpha\"",
        "}",
        "",
        "const tests = [Input.file(\"tests/a.test.ts\"), Input.file(\"tests/b.test.ts\")]",
        "",
        "export const gated = BunTestCoverage({",
        "  tests,",
        "  thresholds: { lines: 40, functions: 50, branches: 0, statements: 0 },",
        "  profile: \"library\",",
        "  ...shared",
        "})",
        "export const gatedHigher = BunTestCoverage({",
        "  tests,",
        "  thresholds: { lines: 45, functions: 50, branches: 0, statements: 0 },",
        "  profile: \"library\",",
        "  ...shared",
        "})",
        "export const unsupported = BunTestCoverage({",
        "  tests,",
        "  thresholds: null,",
        "  profile: null,",
        "  ...shared,",
        "  unsupportedReason: \"Bun coverage cannot instrument the fault matrix.\"",
        "})",
        ""
      ].join("\n")
    )

    const workspace = await Workspace.make(root, root, { cacheDirectory: ".flows" })
    const plan = await Planner.make(workspace, "test", "//packages/alpha/...")
    const entryOf = (label: string) => {
      const planned = plan.targets.find((entry) => entry.label === label)
      if (planned === undefined) throw new Error(`the plan has no target ${label}`)
      return planned
    }

    const gated = entryOf("//packages/alpha:gated")
    const gatedHigher = entryOf("//packages/alpha:gatedHigher")
    const unsupported = entryOf("//packages/alpha:unsupported")

    // The declared thresholds, profile, and ordered file list are key
    // material: they ride in the attrs the key folds.
    const material = JSON.stringify(gated.keyMaterial.inputs)
    expect(material).toContain("\"lines\":40")
    expect(material).toContain("\"profile\":\"library\"")
    expect(material.indexOf("tests/a.test.ts")).toBeLessThan(material.indexOf("tests/b.test.ts"))
    expect(JSON.stringify(unsupported.keyMaterial.inputs)).toContain("fault matrix")

    // Raising a threshold re-keys the target.
    console.log(`lines=40 ${gated.keyPreview}\nlines=45 ${gatedHigher.keyPreview}`)
    expect(gated.keyPreview).not.toBe(gatedHigher.keyPreview)
    expect(gated.keyPreview).not.toBe(unsupported.keyPreview)
  })

  it("keeps profile and thresholds in key material", () => {
    const attrsOf = (extra: Partial<Parameters<typeof BunTestCoverage>[0]>) =>
      Target.metadata(declareCoverage(extra)).attrs as { readonly profile: string | null }
    expect(attrsOf({ profile: "critical" }).profile).toBe("critical")
    expect(attrsOf({ profile: "library" }).profile).toBe("library")
  })
})

describe("BunTest and BunTestCoverage stay distinct rules", () => {
  it("plan different argv for the same test declaration", () => {
    const shared = {
      tests: [Input.file("tests/a.test.ts")],
      sources: [Input.glob("src/**/*.ts")],
      deps: [],
      preload: null,
      timeoutMs: 5000,
      maxConcurrency: 20,
      isolate: false,
      pathIgnorePatterns: [] as ReadonlyArray<string>,
      reporter: null,
      reporterOutfile: null,
      cwd: "packages/alpha"
    }
    const [plain] = execPayloads(BunTest(shared))
    if (plain === undefined) throw new Error("BunTest planned no exec step")
    expect(plain.argv).not.toContain("--coverage")
    const [covered] = execPayloads(
      BunTestCoverage({
        ...shared,
        coverageDir: "coverage",
        coverageReporter: "lcov",
        thresholds: null,
        profile: null,
        unsupportedReason: "No gate yet."
      })
    )
    if (covered === undefined) throw new Error("BunTestCoverage planned no exec step")
    expect(covered.argv).toContain("--coverage")
  })
})
