/**
 * ScriptCheck: verb membership, key material, and exit-code policy.
 *
 * The key assertions plan a real workspace through the planner the CLI runs,
 * so they measure the key the executor would cache on rather than a second
 * key computed here. The exit-code assertions run the payload the rule
 * planned through `Exec.run`, the same call the exec layer makes.
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
import { ScriptCheck } from "../src/ScriptCheck.ts"
import * as Target from "../src/Target.ts"
import "./toolchain.ts"

let root: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-script-check-")))
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

const scriptCheckModule = NodePath.resolve(import.meta.dirname, "../src/ScriptCheck.ts")
const inputModule = NodePath.resolve(import.meta.dirname, "../src/Input.ts")

/** The imports and script fixture every planned workspace in this file shares. */
const writeWorkspaceSkeleton = async (): Promise<void> => {
  await write("package.json", `${JSON.stringify({ name: "fixture", private: true })}\n`)
  await write("scripts/check.mjs", "process.exit(0)\n")
}

/** Plans one verb and returns each target's key by label. */
const planKeys = async (verb: Target.Kind): Promise<Map<string, string>> => {
  const workspace = await Workspace.make(root, root, { cacheDirectory: ".flows" })
  const plan = await Planner.make(workspace, verb, "//...")
  return new Map(plan.targets.map((entry) => [entry.label, entry.keyPreview]))
}

describe("the declared read set is key material", () => {
  it("re-keys when a declared source changes and not when an undeclared one does", async () => {
    await writeWorkspaceSkeleton()
    await write("src/data.txt", "one\n")
    await write("notes/unrelated.txt", "alpha\n")
    await write(
      "BUILD.ts",
      [
        `import { ScriptCheck } from "${scriptCheckModule}"`,
        `import * as Input from "${inputModule}"`,
        "",
        "export const gate = ScriptCheck({",
        "  script: Input.file(\"scripts/check.mjs\"),",
        "  srcs: [Input.file(\"src/data.txt\")],",
        "  deps: [],",
        "  kinds: [\"lint\"]",
        "})",
        ""
      ].join("\n")
    )

    const before = await planKeys("lint")
    const initial = before.get("//:gate")
    expect(initial).toBeDefined()

    // An undeclared edit must not move the key: the gate does not read it.
    await write("notes/unrelated.txt", "beta\n")
    const afterUnrelated = await planKeys("lint")
    expect(afterUnrelated.get("//:gate")).toBe(initial)

    // A declared edit must move the key: the gate read the previous bytes.
    await write("src/data.txt", "two\n")
    const afterDeclared = await planKeys("lint")
    const rekeyed = afterDeclared.get("//:gate")
    // Printed so a reviewer reads the two keys the assertion compares.
    console.log(`declared source unchanged ${initial}\ndeclared source edited   ${rekeyed}`)
    expect(rekeyed).toBeDefined()
    expect(rekeyed).not.toBe(initial)
  })
})

describe("expectedExitCodes", () => {
  it("reaches the planned exec payload", () => {
    const target = ScriptCheck({
      script: Input.file("scripts/check.mjs"),
      args: ["--strict"],
      srcs: [],
      deps: [],
      kinds: ["lint"],
      expectedExitCodes: [0, 3]
    })
    const [payload] = execPayloads(target)
    if (payload === undefined) throw new Error("ScriptCheck planned no exec step")
    expect(payload.argv).toEqual(["node", "scripts/check.mjs", "--strict"])
    expect(payload.expectedExitCodes).toEqual([0, 3])
  })

  it("is honoured by the runner", async () => {
    await writeWorkspaceSkeleton()
    await write("scripts/fail.mjs", "process.exit(3)\n")
    const base = {
      script: Input.file("scripts/fail.mjs"),
      srcs: [],
      deps: [],
      kinds: ["lint"] as ["lint"]
    }
    const accepted = ScriptCheck({ ...base, expectedExitCodes: [0, 3] })
    const rejected = ScriptCheck({ ...base, expectedExitCodes: [0] })
    const [acceptedPayload] = execPayloads(accepted)
    const [rejectedPayload] = execPayloads(rejected)
    if (acceptedPayload === undefined || rejectedPayload === undefined) {
      throw new Error("ScriptCheck planned no exec step")
    }

    const result = await Effect.runPromise(Exec.run({ workspaceRoot: root }, acceptedPayload))
    expect(result.exitCode).toBe(3)

    const failure = await Effect.runPromise(Effect.flip(Exec.run({ workspaceRoot: root }, rejectedPayload)))
    expect(failure.exitCode).toBe(3)
  })
})

describe("verb membership", () => {
  it("plans a lint-kind target under lint and a test-kind target under test", async () => {
    await writeWorkspaceSkeleton()
    await write(
      "BUILD.ts",
      [
        `import { ScriptCheck } from "${scriptCheckModule}"`,
        `import * as Input from "${inputModule}"`,
        "",
        "const declaration = { script: Input.file(\"scripts/check.mjs\"), srcs: [], deps: [] }",
        "",
        "export const lintGate = ScriptCheck({ ...declaration, kinds: [\"lint\"] })",
        "export const testGate = ScriptCheck({ ...declaration, kinds: [\"test\"] })",
        "export const bothGate = ScriptCheck({ ...declaration, kinds: [\"lint\", \"test\"] })",
        ""
      ].join("\n")
    )

    const lint = await planKeys("lint")
    expect([...lint.keys()].sort()).toEqual(["//:bothGate", "//:lintGate"])

    const test = await planKeys("test")
    expect([...test.keys()].sort()).toEqual(["//:bothGate", "//:testGate"])

    // An exact label keeps its strict refusal when the target does not
    // participate in the verb.
    const workspace = await Workspace.make(root, root, { cacheDirectory: ".flows" })
    await expect(Planner.make(workspace, "test", "//:lintGate")).rejects.toBeInstanceOf(
      Planner.UnsupportedVerbError
    )
  })
})

describe("declaration validation", () => {
  it("refuses a kind outside lint and test", () => {
    expect(() =>
      ScriptCheck({
        script: Input.file("scripts/check.mjs"),
        srcs: [],
        deps: [],
        // @ts-expect-error the schema refuses a build kind
        kinds: ["build"]
      })
    ).toThrow(/ScriptCheck declaration.*is invalid/)
  })

  it("refuses an empty kinds list", () => {
    expect(() =>
      ScriptCheck({
        script: Input.file("scripts/check.mjs"),
        srcs: [],
        deps: [],
        // @ts-expect-error the schema refuses an empty verb membership
        kinds: []
      })
    ).toThrow(/ScriptCheck declaration.*is invalid/)
  })
})
