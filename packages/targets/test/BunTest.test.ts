/**
 * Bun test targets.
 *
 * The argv assertions read the exec payload the rule planned, the value the
 * exec layer spawns. The key assertions plan a scratch workspace laid out
 * like the smithers packages through the planner the CLI runs, so the
 * compared value is the key the executor would cache on.
 */
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Planner from "../../build-cli/src/Planner.ts"
import { Workspace } from "../../build-cli/src/Workspace.ts"
import { BunTest } from "../src/BunTest.ts"
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
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-buntest-")))
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

/** The single exec payload a one-step rule plans. */
const onlyPayload = (target: Target.AnyTarget): Exec.Payload => {
  const [payload] = execPayloads(target)
  if (payload === undefined) throw new Error("the rule planned no exec step")
  return payload
}

const declareTarget = (
  tests: Parameters<typeof BunTest>[0]["tests"],
  extra: Partial<Parameters<typeof BunTest>[0]> = {}
) =>
  BunTest({
    tests,
    sources: [Input.glob("src/**/*.ts")],
    deps: [],
    preload: null,
    timeoutMs: 5000,
    maxConcurrency: 20,
    isolate: false,
    pathIgnorePatterns: [],
    reporter: null,
    reporterOutfile: null,
    cwd: "packages/alpha",
    ...extra
  })

describe("BunTest plans a bun test run", () => {
  it("runs bun test through the registered package manager", () => {
    const payload = onlyPayload(declareTarget([Input.glob("tests/**/*.test.ts")]))
    expect(payload.argv.slice(0, 4)).toEqual(["pnpm", "exec", "bun", "test"])
    expect(payload.argv).toContain("--timeout=5000")
    expect(payload.argv).toContain("--max-concurrency=20")
    expect(payload.cwd).toBe("packages/alpha")
    expect(payload.env).toEqual({})
  })

  it("is a cacheable test-kind target", () => {
    const target = declareTarget([Input.glob("tests/**/*")])
    expect(BunTest.kinds).toEqual(["test"])
    expect(Target.metadata(target).cacheable).toBe(true)
  })

  it("passes an explicit file list positionally, in declared order", () => {
    const payload = onlyPayload(
      declareTarget([
        Input.file("tests/first.test.ts"),
        Input.file("tests/second.test.ts"),
        Input.file("tests/third.test.ts")
      ])
    )
    expect(payload.argv.slice(-3)).toEqual([
      "tests/first.test.ts",
      "tests/second.test.ts",
      "tests/third.test.ts"
    ])
  })

  it("threads preload, isolation, ignore patterns, and the junit reporter", () => {
    const payload = onlyPayload(
      declareTarget([Input.glob("tests/**/*")], {
        preload: Input.file("preload.ts"),
        maxConcurrency: 1,
        isolate: true,
        pathIgnorePatterns: ["**/fixtures/**", "**/slow/**"],
        reporter: "junit",
        reporterOutfile: "junit.xml"
      })
    )
    expect(payload.argv).toContain("--preload")
    expect(payload.argv[payload.argv.indexOf("--preload") + 1]).toBe("preload.ts")
    expect(payload.argv).toContain("--max-concurrency=1")
    expect(payload.argv).toContain("--isolate")
    // One flag per pattern: bun parses the value as a single glob.
    expect(payload.argv).toContain("--path-ignore-patterns=**/fixtures/**")
    expect(payload.argv).toContain("--path-ignore-patterns=**/slow/**")
    expect(payload.argv).toContain("--reporter")
    expect(payload.argv).toContain("--reporter-outfile")
    expect(payload.argv[payload.argv.indexOf("--reporter-outfile") + 1]).toBe("junit.xml")
  })

  it("rejects a junit reporter without the file it writes to", () => {
    expect(() => declareTarget([Input.glob("tests/**/*")], { reporter: "junit" })).toThrow(/reporterOutfile/)
  })

  it("refuses an empty test list, which would put the runner into discovery mode", () => {
    const empty = [] as unknown as Parameters<typeof BunTest>[0]["tests"]
    expect(() => declareTarget(empty)).toThrow()
  })

  it("threads the declared environment into the run", () => {
    const payload = onlyPayload(
      declareTarget([Input.glob("tests/**/*")], { env: { FC_SEED: "7" } })
    )
    expect(payload.env).toEqual({ FC_SEED: "7" })
  })
})

describe("BunTest keys on the ordered file list", () => {
  /**
   * A scratch workspace laid out like the smithers packages: one package
   * whose test script is `bun test tests`, and one whose script names every
   * test file explicitly with a preload, the way .smithers does.
   */
  const buildFile = (rulesModule: string, inputModule: string): string =>
    [
      `import { BunTest } from "${rulesModule}"`,
      `import * as Input from "${inputModule}"`,
      "",
      "const shared = {",
      "  sources: [Input.glob(\"src/**/*.ts\")],",
      "  deps: [],",
      "  preload: Input.file(\"preload.ts\"),",
      "  timeoutMs: 5000,",
      "  maxConcurrency: 1,",
      "  isolate: false,",
      "  pathIgnorePatterns: [],",
      "  reporter: null,",
      "  reporterOutfile: null,",
      "  cwd: \"packages/alpha\"",
      "}",
      "",
      "export const ordered = BunTest({",
      "  tests: [Input.file(\"tests/a.test.ts\"), Input.file(\"tests/b.test.ts\")],",
      "  ...shared",
      "})",
      "export const reordered = BunTest({",
      "  tests: [Input.file(\"tests/b.test.ts\"), Input.file(\"tests/a.test.ts\")],",
      "  ...shared",
      "})",
      "export const orderedAgain = BunTest({",
      "  tests: [Input.file(\"tests/a.test.ts\"), Input.file(\"tests/b.test.ts\")],",
      "  ...shared",
      "})",
      ""
    ].join("\n")

  it("gives two targets differing only in file order different keys", async () => {
    const rulesModule = NodePath.resolve(import.meta.dirname, "../src/BunTest.ts")
    const inputModule = NodePath.resolve(import.meta.dirname, "../src/Input.ts")
    await write("package.json", `${JSON.stringify({ name: "fixture", private: true })}\n`)
    await write("BUILD.ts", "export const root = 1\n")
    await write("packages/alpha/package.json", `${JSON.stringify({ name: "alpha", private: true })}\n`)
    await write("packages/alpha/preload.ts", "// preload\n")
    await write("packages/alpha/src/index.ts", "export const alpha = 1\n")
    await write("packages/alpha/tests/a.test.ts", "// a\n")
    await write("packages/alpha/tests/b.test.ts", "// b\n")
    await write("packages/alpha/BUILD.ts", buildFile(rulesModule, inputModule))

    const workspace = await Workspace.make(root, root, { cacheDirectory: ".flows" })
    const plan = await Planner.make(workspace, "test", "//...")
    const keyOf = (label: string): string => {
      const planned = plan.targets.find((entry) => entry.label === label)
      if (planned === undefined) throw new Error(`the plan has no target ${label}`)
      return planned.keyPreview
    }

    const ordered = keyOf("//packages/alpha:ordered")
    const reordered = keyOf("//packages/alpha:reordered")
    const again = keyOf("//packages/alpha:orderedAgain")

    // Printed so a reviewer reads the keys the assertion compares.
    console.log(`a,b ${ordered}\nb,a ${reordered}`)
    expect(ordered).not.toBe(reordered)
    expect(again).toBe(ordered)
  })
})
