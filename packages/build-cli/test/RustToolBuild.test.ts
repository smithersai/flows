/**
 * The Rust lane is a declaration, not a subsystem.
 *
 * `crates/flows-jj/BUILD.ts` declares the four CI verbs as `ToolBuild`
 * genrules. These cases load that file through the real workspace loader and
 * plan it through the real planner, so an attrs-schema change, a declared
 * output that stops being legal, or a glob that stops matching fails here.
 * Cargo never runs: the cases assert the declaration and its key material,
 * and the rebuild itself is a CI gate.
 */
import * as Target from "@smthrs/targets/Target"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Planner from "../src/Planner.ts"
import { Workspace } from "../src/Workspace.ts"

/** The repository root, four levels above this file. */
const repositoryRoot = NodePath.resolve(
  NodePath.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".."
)

const buildFile = "crates/flows-jj/BUILD.ts"

interface ToolBuildAttrs {
  readonly tool: string
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly outputs: ReadonlyArray<string>
  readonly cache: boolean
  readonly cwd: string
}

const attrsOf = async (name: string): Promise<ToolBuildAttrs> => {
  const workspace = await Workspace.make(repositoryRoot)
  const module = await workspace.loadBuild(buildFile)
  const target = module.targets.get(name)
  if (target === undefined) throw new Error(`${buildFile} does not export ${name}`)
  return Target.metadata(target).attrs as ToolBuildAttrs
}

describe("crates/flows-jj/BUILD.ts", () => {
  it("declares the four CI verbs as ToolBuild targets", async () => {
    const workspace = await Workspace.make(repositoryRoot)
    const module = await workspace.loadBuild(buildFile)

    for (const name of ["fmt", "clippy", "test", "wasm"]) {
      const target = module.targets.get(name)
      expect(target, `${buildFile} exports ${name}`).toBeDefined()
      const metadata = Target.metadata(target!)
      expect(metadata.target).toBe("ToolBuild")
      // `build` only. A Rust target must not be selected by the `docs` verb
      // the documentation gate runs over the whole workspace.
      expect(metadata.kinds).toEqual(["build"])
    }
  })

  it("runs the cargo verbs ci.yml runs, from the cargo workspace root", async () => {
    expect(await attrsOf("fmt")).toMatchObject({
      tool: "cargo",
      command: "cargo",
      args: ["fmt", "--check"],
      outputs: [],
      cwd: "."
    })
    expect(await attrsOf("clippy")).toMatchObject({
      command: "cargo",
      args: ["clippy", "--all-targets", "--locked", "--", "-D", "warnings"],
      outputs: [],
      cwd: "."
    })
    expect(await attrsOf("test")).toMatchObject({
      command: "cargo",
      args: ["test", "--locked"],
      outputs: [],
      cwd: "."
    })
  })

  it("declares the committed wasm artifact as the wasm target's output", async () => {
    expect(await attrsOf("wasm")).toMatchObject({
      tool: "node",
      command: "node",
      args: ["crates/flows-jj/build-wasm.mjs"],
      outputs: ["packages/jj/wasm/flows_jj.wasm"],
      cwd: "."
    })
  })

  it("never caches the wasm rebuild, because the rebuild is the gate", async () => {
    const workspace = await Workspace.make(repositoryRoot)
    const module = await workspace.loadBuild(buildFile)
    const wasm = module.targets.get("wasm")!

    expect(Target.metadata(wasm).cacheable).toBe(false)
    // The value comes from the declaration, so a change to the rule catalog's
    // cache default cannot turn this gate back on.
    expect((Target.metadata(wasm).attrs as ToolBuildAttrs).cache).toBe(false)
  })

  it("never caches the two verbs that compile the vendored jj-lib", async () => {
    // `vendor/jj` is a submodule and no declaration below reaches it, so the
    // key material of anything that compiles it is incomplete.
    expect((await attrsOf("clippy")).cache).toBe(false)
    expect((await attrsOf("test")).cache).toBe(false)
    // `cargo fmt` reads this crate's sources alone, which are all declared.
    expect((await attrsOf("fmt")).cache).toBe(true)
  })

  it("expands every declared input to at least one existing file", async () => {
    const workspace = await Workspace.make(repositoryRoot)
    const plan = await Planner.make(workspace, "build", "//crates/flows-jj/...")

    expect(plan.targets.map((target) => target.label).sort()).toEqual([
      "//crates/flows-jj:clippy",
      "//crates/flows-jj:fmt",
      "//crates/flows-jj:test",
      "//crates/flows-jj:wasm"
    ])

    for (const target of plan.targets) {
      expect(target.declaredInputs.length, target.label).toBeGreaterThan(0)
      for (const input of target.declaredInputs) {
        // A glob that matches nothing and a file that does not exist both
        // reach key material as an empty or undigested entry, which silently
        // drops a real input out of the key.
        expect(input.files.length, `${target.label} ${JSON.stringify(input.declaration)}`).toBeGreaterThan(0)
        for (const file of input.files) {
          expect(file.digest, `${target.label} ${file.path}`).toBeTypeOf("string")
        }
      }
    }
  })

  it("declares the crate sources, the lockfile, and the toolchain pin", async () => {
    const workspace = await Workspace.make(repositoryRoot)
    const plan = await Planner.make(workspace, "build", "//crates/flows-jj:fmt")
    const paths = plan.targets[0]!.declaredInputs.flatMap((input) => input.files.map((file) => file.path))

    expect(paths).toContain("crates/flows-jj/src/lib.rs")
    expect(paths).toContain("crates/flows-jj/tests/test_ops.rs")
    expect(paths).toContain("crates/flows-jj/Cargo.toml")
    expect(paths).toContain("Cargo.lock")
    expect(paths).toContain("rust-toolchain.toml")
  })
})
