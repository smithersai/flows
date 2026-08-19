import * as Target from "@smthrs/targets/Target"
import * as NodePath from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { tsImport } from "tsx/esm/api"
import { describe, expect, it } from "vitest"
import * as WorkspaceModule from "../src/Workspace.ts"

/**
 * The repository root this package sits in. The guard runs against the real
 * checkout on purpose: the committed BUILD.ts files are executable
 * declarations, and a targets-API change that invalidates one of them must fail
 * here rather than at the next `smthrs` invocation. This is the rot that
 * actually happened once — `entries` became `file()` objects and three
 * checked-in BUILD.ts files kept the string form for weeks because nothing
 * loaded them.
 */
const repositoryRoot = NodePath.resolve(
  NodePath.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".."
)

/**
 * The workspace loader, evaluated through tsx rather than through vitest's
 * own module runner.
 *
 * The root BUILD.ts reads the registered toolchain while it declares
 * `workspace`, `lockfile`, and `nodeModules`, and a read before registration
 * is an error. The registration propagates from WORKSPACE.ts only when every
 * declaration evaluates in one loader graph, which is what the CLI's own
 * bootstrap produces. A vitest-native import of this module evaluates each
 * BUILD.ts in an isolated graph instead, so loading the root BUILD.ts here
 * would fail. Importing the module through `tsImport` gives the test the
 * same single graph the CLI runs in; the file never changes during a run, so
 * the memoized evaluation registers once.
 */
const { Workspace } = (await tsImport(
  pathToFileURL(NodePath.join(repositoryRoot, "packages/build-cli/src/Workspace.ts")).href,
  { parentURL: pathToFileURL(NodePath.join(repositoryRoot, "committed-build-files-probe.js")).href, tsconfig: false }
)) as typeof WorkspaceModule

describe("committed BUILD.ts files", () => {
  it("every committed BUILD.ts loads and all of its declarations construct", async () => {
    const workspace = await Workspace.make(repositoryRoot)
    expect(workspace.buildFiles.length).toBeGreaterThan(0)
    for (const file of workspace.buildFiles) {
      // `loadBuild` imports the module, which runs every target call in it, so
      // an attrs-schema rejection or an invalid declared output throws here
      // with the file and line in the message.
      await expect(workspace.loadBuild(file), file).resolves.toBeDefined()
    }
  })

  it("the standard-package BUILD.ts files declare six package-local targets", async () => {
    const workspace = await Workspace.make(repositoryRoot)
    for (
      const file of [
        "packages/engine/BUILD.ts",
        "packages/flow/BUILD.ts",
        "packages/plan/BUILD.ts",
        "packages/build/BUILD.ts"
      ]
    ) {
      const module = await workspace.loadBuild(file)
      const packagePath = NodePath.posix.dirname(file)
      for (const name of ["lib", "check", "test", "lint", "fmt", "docs"]) {
        expect(module.targets.has(name), `${file} exports ${name}`).toBe(true)
        const attrs = Target.metadata(module.targets.get(name)!).attrs as { readonly cwd?: string }
        expect(attrs.cwd, `${file} anchors ${name} in its package`).toBe(packagePath)
      }
    }
  })
})
