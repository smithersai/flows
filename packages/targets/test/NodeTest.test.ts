/**
 * NodeTest: argv construction, key material, and real `node --test` runs.
 *
 * The key assertion plans a real workspace through the planner the CLI runs,
 * so it measures the key the executor would cache on rather than a second key
 * computed here. The run assertions execute the payload the rule planned
 * through `Exec.run`, the same call the exec layer makes.
 */
import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Planner from "../../build-cli/src/Planner.ts"
import { Workspace } from "../../build-cli/src/Workspace.ts"
import * as Exec from "../src/Exec.ts"
import * as Input from "../src/Input.ts"
import { NodeTest } from "../src/NodeTest.ts"
import * as Target from "../src/Target.ts"
import "./toolchain.ts"

let root: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-node-test-")))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

/** Every exec payload one target's body plans, in the order the walk reaches them. */
const execPayloads = (target: Target.AnyTarget): ReadonlyArray<Exec.Payload> => {
  const found: Array<(typeof Exec.Payload)["~type.make.in"]> = []
  const visit = (node: unknown, seen: Set<object>): void => {
    if (node === null || typeof node !== "object" || seen.has(node)) return
    seen.add(node)
    const ast = node as Record<string, unknown>
    if (ast["_tag"] === "ActionCall") {
      if (ast["action"] === "smithers-build/exec") {
        found.push(ast["payload"] as (typeof Exec.Payload)["~type.make.in"])
      }
      return
    }
    for (const value of Object.values(ast)) visit(value, seen)
  }
  visit(
    (target as unknown as { readonly body: (attrs: unknown) => { readonly ast: unknown } })
      .body(Target.metadata(target).attrs).ast,
    new Set()
  )
  // A planned payload omits the schema's constructor defaults; the exec
  // action applies them when it validates what it receives, so the runner
  // assertions do the same here.
  return found.map((payload) => Exec.Payload.make(payload))
}

describe("argv construction", () => {
  it("passes the declared test files to node --test in order", () => {
    const target = NodeTest({
      tests: [Input.file("test/a.test.mjs"), Input.file("test/b.test.mjs")],
      sources: [Input.glob("scripts/**/*.mjs")],
      deps: []
    })
    const metadata = Target.metadata(target)
    expect(metadata.kinds).toEqual(["test"])
    expect(metadata.cacheable).toBe(true)
    const [payload] = execPayloads(target)
    if (payload === undefined) throw new Error("NodeTest planned no exec step")
    expect(payload.argv).toEqual(["node", "--test", "test/a.test.mjs", "test/b.test.mjs"])
    expect(payload.cwd).toBe(".")
    expect(payload.env).toEqual({})
  })

  it("maps concurrency onto the runner flag", () => {
    const target = NodeTest({
      tests: [Input.file("test/a.test.mjs")],
      sources: [],
      deps: [],
      concurrency: 2,
      cwd: "packages/alpha",
      env: { FC_SEED: "7" }
    })
    const [payload] = execPayloads(target)
    if (payload === undefined) throw new Error("NodeTest planned no exec step")
    expect(payload.argv).toEqual(["node", "--test", "--concurrency", "2", "test/a.test.mjs"])
    expect(payload.cwd).toBe("packages/alpha")
    expect(payload.env).toEqual({ FC_SEED: "7" })
  })
})

describe("declaration validation", () => {
  it("refuses an empty test list, which would put the runner into discovery mode", () => {
    expect(() =>
      NodeTest({
        // @ts-expect-error the schema refuses an empty test list
        tests: [],
        sources: [],
        deps: []
      })
    ).toThrow(/NodeTest declaration.*is invalid/)
  })
})

describe("the declared read set is key material", () => {
  it("re-keys when a declared source changes", async () => {
    const nodeTestModule = NodePath.resolve(import.meta.dirname, "../src/NodeTest.ts")
    const inputModule = NodePath.resolve(import.meta.dirname, "../src/Input.ts")
    await write("package.json", `${JSON.stringify({ name: "fixture", private: true })}\n`)
    await write("test/sample.test.mjs", "import test from \"node:test\"\ntest(\"ok\", () => {})\n")
    await write("src/helper.mjs", "export const value = 1\n")
    await write(
      "BUILD.ts",
      [
        `import { NodeTest } from "${nodeTestModule}"`,
        `import * as Input from "${inputModule}"`,
        "",
        "export const suite = NodeTest({",
        "  tests: [Input.file(\"test/sample.test.mjs\")],",
        "  sources: [Input.file(\"src/helper.mjs\")],",
        "  deps: []",
        "})",
        ""
      ].join("\n")
    )

    const keyOf = async (): Promise<string> => {
      const workspace = await Workspace.make(root, root, { cacheDirectory: ".flows" })
      const plan = await Planner.make(workspace, "test", "//:suite")
      const planned = plan.targets.find((entry) => entry.label === "//:suite")
      if (planned === undefined) throw new Error("the plan has no target //:suite")
      return planned.keyPreview
    }

    const before = await keyOf()
    await write("src/helper.mjs", "export const value = 2\n")
    const after = await keyOf()
    // Printed so a reviewer reads the two keys the assertion compares.
    console.log(`declared source unchanged ${before}\ndeclared source edited   ${after}`)
    expect(after).not.toBe(before)
  })
})

describe("execution", () => {
  it("runs a real node:test suite through the planned payload", async () => {
    await write(
      "test/sample.test.mjs",
      [
        "import assert from \"node:assert/strict\"",
        "import test from \"node:test\"",
        "",
        "test(\"arithmetic\", () => {",
        "  assert.equal(1 + 1, 2)",
        "})",
        ""
      ].join("\n")
    )
    const target = NodeTest({
      tests: [Input.file("test/sample.test.mjs")],
      sources: [],
      deps: []
    })
    const [payload] = execPayloads(target)
    if (payload === undefined) throw new Error("NodeTest planned no exec step")

    const result = await Effect.runPromise(Exec.run({ workspaceRoot: root }, payload))
    expect(result.exitCode).toBe(0)
  })

  it("fails the target when a suite fails", async () => {
    await write(
      "test/broken.test.mjs",
      [
        "import assert from \"node:assert/strict\"",
        "import test from \"node:test\"",
        "",
        "test(\"arithmetic\", () => {",
        "  assert.equal(1 + 1, 3)",
        "})",
        ""
      ].join("\n")
    )
    const target = NodeTest({
      tests: [Input.file("test/broken.test.mjs")],
      sources: [],
      deps: []
    })
    const [payload] = execPayloads(target)
    if (payload === undefined) throw new Error("NodeTest planned no exec step")

    const failure = await Effect.runPromise(Effect.flip(Exec.run({ workspaceRoot: root }, payload)))
    expect(failure.exitCode).toBe(1)
  })
})
