/**
 * The publish half of the package macro: what `StandardPackage` emits, what
 * that target publishes, and why no build, test, lint, or docs graph can reach
 * it.
 *
 * Nothing here publishes. Every assertion reads the planned argv out of the
 * target's body, so the test states what a run would do without doing it.
 */
import * as Node from "@smthrs/plan/Node"
import { describe, expect, it } from "vitest"
import { EsLint } from "../src/EsLint.ts"
import { NpmPublish, viewArgv } from "../src/NpmPublish.ts"
import * as PackageDefaults from "../src/PackageDefaults.ts"
import * as PackageManager from "../src/PackageManager.ts"
import * as Runtime from "../src/Runtime.ts"
import { StandardPackage } from "../src/StandardPackage.ts"
import * as Target from "../src/Target.ts"
import "./toolchain.ts"

/** The manifest fields `PackageDefaults.expand` reads for one engine package. */
const journalManifest = {
  name: "@smthrs/journal",
  version: "0.1.0",
  smthrs: { group: "engine" }
}

/** A `ManifestIo` answering one fixture manifest per directory. */
const manifestIo = (
  manifests: Readonly<Record<string, unknown>>
): PackageDefaults.ManifestIo => ({
  readText: (path) => {
    const directory = path.split("/").slice(-2)[0]
    const manifest = directory === undefined ? undefined : manifests[directory]
    return manifest === undefined ? undefined : JSON.stringify(manifest)
  }
})

/** The engine package the macro expands throughout this file. */
const journal = StandardPackage({
  cwd: "packages/journal",
  name: journalManifest.name,
  version: journalManifest.version,
  group: journalManifest.smthrs.group
})

/** Every argv one target's body plans, in the order the walk reaches them. */
const plannedArgv = (target: Target.AnyTarget): ReadonlyArray<ReadonlyArray<string>> => {
  const found: Array<ReadonlyArray<string>> = []
  const visit = (ast: Node.Ast): void => {
    if (ast._tag === "ActionCall") {
      const payload = ast.payload as { readonly argv?: ReadonlyArray<string> }
      if (Array.isArray(payload.argv)) found.push(payload.argv)
      return
    }
    if (ast._tag === "Branch") {
      visit(ast.first)
      visit(ast.then)
      visit(ast.else)
      return
    }
    if (ast._tag === "Map" || ast._tag === "AndThen") visit(ast.first)
  }
  visit(
    (target as unknown as { readonly body: (attrs: unknown) => Node.Node<unknown> })
      .body(Target.metadata(target).attrs).ast
  )
  return found
}

/** The body of one target, as its plan AST. */
const plan = (target: Target.AnyTarget): Node.Ast =>
  (target as unknown as { readonly body: (attrs: unknown) => Node.Node<unknown> })
    .body(Target.metadata(target).attrs).ast

/**
 * Refuses one verb over a dependency closure the way `Planner.make` does.
 *
 * The planner asserts the gate on every target it visits, not only on the
 * roots, so a gated target poisons the verb through any depth of dependency.
 * This mirrors that rule, because the planner lives in `@smthrs/build-cli` and
 * this package does not depend on it.
 */
const refusal = (verb: Target.Kind, root: Target.AnyTarget): string | undefined => {
  const pending = [root]
  const seen = new Set<Target.AnyTarget>()
  while (pending.length > 0) {
    const target = pending.pop()
    if (target === undefined || seen.has(target)) continue
    seen.add(target)
    const metadata = Target.metadata(target)
    if (metadata.verbGate !== undefined && !metadata.verbGate.includes(verb)) {
      return `${metadata.target} is gated to ${metadata.verbGate.join(", ")}`
    }
    pending.push(...metadata.dependencies)
  }
  return undefined
}

describe("the package macro emits a publish target", () => {
  it("returns a seventh target named publish", () => {
    expect(Object.keys(journal).sort()).toEqual(["check", "docs", "fmt", "lib", "lint", "publish", "test"])
    expect(Target.metadata(journal.publish!).target).toBe("NpmPublish")
  })

  it("gates it to the run verb", () => {
    expect(Target.metadata(journal.publish!).verbGate).toEqual(["run"])
    expect(Target.metadata(journal.publish!).kinds).toEqual(["run"])
  })

  it("emits nothing for a package outside the release group, a private package, or an unnamed one", () => {
    const agent = StandardPackage({ cwd: "packages/cli", name: "@smthrs/cli", version: "0.1.0", group: "agent" })
    expect(agent.publish).toBeUndefined()
    const priv = StandardPackage({
      cwd: "packages/targets",
      name: "@smthrs/targets",
      version: "0.1.0",
      group: "engine",
      private: true
    })
    expect(priv.publish).toBeUndefined()
    expect(StandardPackage({ cwd: "packages/journal", group: "engine" }).publish).toBeUndefined()
  })

  it("depends on the build whose output the tarball carries", () => {
    expect(Target.metadata(journal.publish!).dependencies).toEqual([journal.lib])
  })
})

describe("the publish target publishes a tarball", () => {
  const [probe, publish] = plannedArgv(journal.publish!)

  it("names the staged tarball, never the working package directory", () => {
    expect(publish).toEqual([
      "pnpm",
      "publish",
      ".artifacts/release-packs/smthrs-journal-0.1.0.tgz",
      "--registry",
      "https://registry.npmjs.org",
      "--access",
      "public",
      "--tag",
      "latest",
      "--no-git-checks",
      "--dry-run"
    ])
    expect(publish).not.toContain("packages/journal")
    expect(publish).not.toContain(".")
  })

  it("declares the tarball as an input beside the manifest", () => {
    expect(Target.metadata(journal.publish!).inputs).toEqual([
      { _tag: "File", path: "package.json" },
      { _tag: "File", path: "//.artifacts/release-packs/smthrs-journal-0.1.0.tgz" }
    ])
  })

  it("passes provenance on argv only when it really publishes", () => {
    expect(publish).not.toContain("--provenance")
    const real = NpmPublish({
      ...(Target.metadata(journal.publish!).attrs as Parameters<typeof NpmPublish>[0]),
      dryRun: false
    })
    const argv = plannedArgv(real)[1]!
    expect(argv).toContain("--provenance")
    expect(argv).not.toContain("--dry-run")
    expect(argv.at(-1)).toBe("--provenance")
  })

  it("publishes a prerelease version to the next dist-tag", () => {
    const next = StandardPackage({
      cwd: "packages/journal",
      name: "@smthrs/journal",
      version: "0.2.0-rc.1",
      group: "engine"
    }).publish!
    const argv = plannedArgv(next)[1]!
    expect(argv.slice(argv.indexOf("--tag"), argv.indexOf("--tag") + 2)).toEqual(["--tag", "next"])
    expect(argv).toContain(".artifacts/release-packs/smthrs-journal-0.2.0-rc.1.tgz")
  })

  it("probes the registry before it publishes", () => {
    expect(probe).toEqual(["pnpm", "view", "@smthrs/journal@0.1.0", "version", "--json"])
  })

  it("spells the probe the way each manager spells it", () => {
    const runtime = Runtime.Node({ version: "24.9.0" })
    const spec = "@smthrs/journal@0.1.0"
    expect(viewArgv(PackageManager.Npm({ version: "10.9.0", runtime }), spec))
      .toEqual(["npm", "view", spec, "version", "--json"])
    expect(viewArgv(PackageManager.Yarn({ version: "4.5.0", runtime }), spec))
      .toEqual(["yarn", "npm", "info", spec, "version", "--json"])
    expect(viewArgv(PackageManager.BunPackages({ runtime: Runtime.Bun({ version: "1.3.0" }) }), spec))
      .toEqual(["bun", "x", "npm", "view", spec, "version", "--json"])
  })
})

describe("an already-published version is skipped", () => {
  const ast = plan(journal.publish!)

  it("branches on the probe and short-circuits a published spec", () => {
    expect(ast._tag).toBe("Branch")
    if (ast._tag !== "Branch") return
    expect(ast.then._tag).toBe("Succeed")
    expect(ast.else._tag).toBe("ActionCall")
    if (ast.else._tag !== "ActionCall") return
    expect(ast.else.action).toBe("smithers-build/exec-irreversible")
  })

  it("decides on the probe's exit code", () => {
    const decide = Node.predicate(ast)
    expect(decide).toBeDefined()
    expect(decide!({ exitCode: 0, stdout: "\"0.1.0\"", stderr: "" })).toBe(true)
    expect(decide!({ exitCode: 1, stdout: "", stderr: "404" })).toBe(false)
  })

  it("treats a spec the registry does not have as an answer, not a failure", () => {
    if (ast._tag !== "Branch" || ast.first._tag !== "ActionCall") throw new Error("expected a probed branch")
    expect(ast.first.action).toBe("smithers-build/exec")
    expect((ast.first.payload as { readonly expectedExitCodes: ReadonlyArray<number> }).expectedExitCodes)
      .toEqual([0, 1])
  })
})

describe("no build, test, lint, or docs graph reaches the publish target", () => {
  it.each(["build", "test", "lint", "docs"] as const)("%s over the macro's own targets", (verb) => {
    for (const target of [journal.lib, journal.check, journal.test, journal.lint, journal.fmt, journal.docs]) {
      expect(refusal(verb, target)).toBeUndefined()
    }
  })

  it.each(["build", "test", "lint", "docs"] as const)("%s refuses a target that reaches it transitively", (verb) => {
    const direct = EsLint({
      sources: [],
      deps: [journal.publish!],
      configs: [],
      maxWarnings: 0,
      fix: false,
      cwd: "packages/journal"
    })
    const indirect = EsLint({
      sources: [],
      deps: [direct],
      configs: [],
      maxWarnings: 0,
      fix: false,
      cwd: "packages/journal"
    })
    expect(refusal(verb, indirect)).toBe("NpmPublish is gated to run")
    expect(refusal("run", indirect)).toBeUndefined()
  })
})

describe("synthesis passes the directory's manifest to the macro", () => {
  const declaration = PackageDefaults.PackageDefaults({
    directories: "packages/*",
    macro: StandardPackage
  })
  const io = manifestIo({
    journal: journalManifest,
    cli: { name: "@smthrs/cli", version: "0.1.0", smthrs: { group: "agent" } }
  })

  it("reads name, version, and smthrs.group", () => {
    expect(PackageDefaults.readManifest("packages/journal", { root: "/w", io })).toEqual({
      directory: "packages/journal",
      name: "@smthrs/journal",
      version: "0.1.0",
      smthrs: { group: "engine" },
      private: false
    })
  })

  it("answers undefined fields for a directory with no readable manifest", () => {
    expect(PackageDefaults.readManifest("packages/absent", { root: "/w", io })).toEqual({
      directory: "packages/absent",
      name: undefined,
      version: undefined,
      smthrs: { group: undefined },
      private: false
    })
  })

  it("synthesizes publish for the engine package and not for the agent package", () => {
    const engine = PackageDefaults.expand(declaration, "packages/journal", { root: "/w", io })
    const publish = engine.targets.find(([name]) => name === "publish")
    expect(publish).toBeDefined()
    expect(Target.metadata(publish![1]).attrs).toMatchObject({
      package: "@smthrs/journal",
      version: "0.1.0",
      tag: "latest"
    })
    const agent = PackageDefaults.expand(declaration, "packages/cli", { root: "/w", io })
    expect(agent.targets.map(([name]) => name)).not.toContain("publish")
  })
})
