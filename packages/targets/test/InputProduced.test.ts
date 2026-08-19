/**
 * Output-keyed dependency edges.
 *
 * A consumer that keys on a producer's target key alone is unsound whenever
 * the producer is not cacheable. An agent target invoked with unchanged attrs
 * and unchanged declared inputs holds its key still while emitting different
 * bytes on every run, so a consumer keyed on the edge would hit its own cache
 * and replay a verdict about output that no longer exists. `Input.produced`
 * puts the producer's output digest in the consumer's key material, so the
 * consumer re-keys exactly when the bytes change.
 *
 * The digest is the one output capture already computed. These tests measure
 * real directories with `ToolBuild.measureOutputs`, the same call the capture
 * action runs, so nothing here can pass against a second digest of its own.
 */
import * as Schema from "effect/Schema"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as Target from "../src/Target.ts"
import * as ToolBuild from "../src/ToolBuild.ts"

/**
 * A producer whose bytes move under a fixed key: nothing in its attrs, its
 * declared inputs, or its implementation describes what it emits. This is the
 * shape of an agent target.
 */
const Agent = Target.make("ProducedTestAgent", {
  attrs: Schema.Struct({ prompt: Schema.NonEmptyString }),
  kinds: ["build"],
  cache: false,
  outputs: () => ({ cwd: ".", paths: ["patch", "report.json"] }),
  implementation: () => Target.notImplemented("ProducedTestAgent")
})

const Reviewer = Target.make("ProducedTestReviewer", {
  attrs: Schema.Struct({ patch: Input.Produced }),
  kinds: ["build"],
  implementation: () => Target.notImplemented("ProducedTestReviewer")
})

const Check = Target.make("ProducedTestCheck", {
  attrs: Schema.Struct({}),
  kinds: ["build"],
  implementation: () => Target.notImplemented("ProducedTestCheck")
})

let root: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

beforeEach(async () => {
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-produced-"))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("a produced input is key material, not just an edge", () => {
  it("re-keys when the producer's bytes change under an unchanged producer key", async () => {
    const producer = Agent({ prompt: "fix the failing test" })
    const declaration = Input.produced(producer, "patch")

    await write("patch/change.diff", "-const a = 1\n+const a = 2\n")
    const before = await ToolBuild.measureOutputs(root, ".", ["patch"])
    const beforeKey = Target.metadata(producer).implementationDigest

    // The second invocation of the same uncached agent. Same attrs, same
    // declaration, same implementation, different bytes.
    await write("patch/change.diff", "-const a = 1\n+const a = 3\n")
    const after = await ToolBuild.measureOutputs(root, ".", ["patch"])
    const afterKey = Target.metadata(Agent({ prompt: "fix the failing test" })).implementationDigest

    expect(afterKey).toBe(beforeKey)
    expect(after.outputs[0]!.contentDigest).not.toBe(before.outputs[0]!.contentDigest)
    expect(Input.producedDigest(declaration, "producer-key", after))
      .not.toBe(Input.producedDigest(declaration, "producer-key", before))
  })

  it("holds the consumer's key still when the producer re-emits the same bytes", async () => {
    const declaration = Input.produced(Agent({ prompt: "fix the failing test" }), "patch")

    await write("patch/change.diff", "-const a = 1\n+const a = 2\n")
    const first = await ToolBuild.measureOutputs(root, ".", ["patch"])
    await Fs.rm(NodePath.join(root, "patch"), { recursive: true })
    await write("patch/change.diff", "-const a = 1\n+const a = 2\n")
    const second = await ToolBuild.measureOutputs(root, ".", ["patch"])

    expect(Input.producedDigest(declaration, "producer-key", second))
      .toBe(Input.producedDigest(declaration, "producer-key", first))
  })

  it("keys on the producer's key as well as its bytes", async () => {
    const declaration = Input.produced(Agent({ prompt: "fix the failing test" }), "patch")
    await write("patch/change.diff", "one\n")
    const manifest = await ToolBuild.measureOutputs(root, ".", ["patch"])

    expect(Input.producedDigest(declaration, "producer-key-a", manifest))
      .not.toBe(Input.producedDigest(declaration, "producer-key-b", manifest))
  })

  it("distinguishes two selectors over one manifest", async () => {
    const producer = Agent({ prompt: "fix the failing test" })
    await write("patch/change.diff", "one\n")
    await write("report.json", "{}\n")
    const manifest = await ToolBuild.measureOutputs(root, ".", ["patch", "report.json"])

    const whole = Input.produced(producer)
    const patch = Input.produced(producer, "patch")
    const report = Input.produced(producer, "report.json")
    const digests = new Set(
      [whole, patch, report].map((declaration) => Input.producedDigest(declaration, "producer-key", manifest))
    )
    expect(digests.size).toBe(3)
  })

  it("re-keys a whole-tree selector when any one output moves", async () => {
    const declaration = Input.produced(Agent({ prompt: "fix the failing test" }))
    await write("patch/change.diff", "one\n")
    await write("report.json", "{\"verdict\":\"pass\"}\n")
    const before = await ToolBuild.measureOutputs(root, ".", ["patch", "report.json"])
    await write("report.json", "{\"verdict\":\"fail\"}\n")
    const after = await ToolBuild.measureOutputs(root, ".", ["patch", "report.json"])

    expect(Input.producedDigest(declaration, "producer-key", after))
      .not.toBe(Input.producedDigest(declaration, "producer-key", before))
  })

  it("reuses the capture digest rather than computing a second one", async () => {
    const declaration = Input.produced(Agent({ prompt: "fix the failing test" }), "patch")
    await write("patch/change.diff", "one\n")
    const manifest = await ToolBuild.measureOutputs(root, ".", ["patch"])

    expect(Input.producedSelection(declaration, manifest))
      .toEqual([{ path: "patch", contentDigest: manifest.outputs[0]!.contentDigest }])
  })

  it("orders a whole-tree selection by path, not by report order", () => {
    const declaration = Input.produced(Agent({ prompt: "fix the failing test" }))
    const forward = { outputs: [{ path: "patch", contentDigest: "aa" }, { path: "report.json", contentDigest: "bb" }] }
    const reversed = { outputs: [{ path: "report.json", contentDigest: "bb" }, { path: "patch", contentDigest: "aa" }] }

    expect(Input.producedSelection(declaration, reversed)).toEqual(Input.producedSelection(declaration, forward))
    expect(Input.producedDigest(declaration, "producer-key", reversed))
      .toBe(Input.producedDigest(declaration, "producer-key", forward))
  })
})

describe("a produced input is refused where the author wrote it", () => {
  it("refuses a producer that declares no outputs", () => {
    const producer = Check({})
    expect(() => Input.produced(producer)).toThrow(Input.ProducedError)
    expect(() => Input.produced(producer)).toThrow(/ProducedTestCheck declares no outputs/)
  })

  it("refuses a producer that declares no outputs behind an explicit selector", () => {
    expect(() => Input.produced(Check({}), "dist")).toThrow(Input.ProducedError)
  })

  it("carries the rejected declaration on the typed error", () => {
    try {
      Input.produced(Check({}), "dist")
      expect.unreachable("the declaration was accepted")
    } catch (cause) {
      expect(cause).toBeInstanceOf(Input.ProducedError)
      const error = cause as Input.ProducedError
      expect(error._tag).toBe("smithers-build/ProducedError")
      expect(error.target).toBe("ProducedTestCheck")
      expect(error.path).toBe("dist")
    }
  })

  it("refuses a selector the producer does not declare", () => {
    expect(() => Input.produced(Agent({ prompt: "p" }), "dist"))
      .toThrow(/does not declare the output "dist"/)
  })

  it("refuses an empty selector", () => {
    expect(() => Input.produced(Agent({ prompt: "p" }), "")).toThrow(Input.ProducedError)
  })

  it("refuses a reference that is not a target", () => {
    expect(() => Input.produced(undefined as never)).toThrow(/must reference a BUILD.ts target/)
  })

  it("refuses a manifest that omits the selected output", () => {
    const declaration = Input.produced(Agent({ prompt: "p" }), "patch")
    expect(() => Input.producedSelection(declaration, { outputs: [{ path: "report.json", contentDigest: "aa" }] }))
      .toThrow(/reported no output named "patch"/)
  })

  it("refuses a manifest that reports the selected output twice", () => {
    const declaration = Input.produced(Agent({ prompt: "p" }), "patch")
    const manifest = { outputs: [{ path: "patch", contentDigest: "aa" }, { path: "patch", contentDigest: "bb" }] }
    expect(() => Input.producedSelection(declaration, manifest)).toThrow(/reported the output "patch" 2 times/)
  })
})

describe("a produced input is an ordering edge as well", () => {
  it("records the producer as a dependency of the consumer", () => {
    const producer = Agent({ prompt: "fix the failing test" })
    const consumer = Reviewer({ patch: Input.produced(producer, "patch") })
    const metadata = Target.metadata(consumer)

    expect(metadata.dependencies).toContain(producer)
    expect(metadata.inputs.filter((input) => input._tag === "Produced")).toHaveLength(1)
  })

  it("records the producer once when two selectors name it", () => {
    const producer = Agent({ prompt: "fix the failing test" })
    const consumer = ToolBuild.ToolBuild({
      tool: "review",
      command: "review",
      args: [],
      inputs: [Input.produced(producer, "patch"), Input.produced(producer, "report.json")],
      outputs: ["verdict.json"],
      deps: [],
      env: {},
      cache: true,
      cwd: "."
    })
    const metadata = Target.metadata(consumer)

    expect(metadata.dependencies.filter((dependency) => dependency === producer)).toHaveLength(1)
    expect(metadata.inputs.filter((input) => input._tag === "Produced")).toHaveLength(2)
  })

  it("is admitted by the declared-input union the planner walks", () => {
    const declaration = Input.produced(Agent({ prompt: "p" }), "patch")
    expect(Input.isDeclared(declaration)).toBe(true)
    expect(Schema.is(Input.Declared)(declaration)).toBe(true)
  })
})
