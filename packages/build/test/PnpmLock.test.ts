import { NodeServices } from "@effect/platform-node"
import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as PackageManager from "../src/PackageManager.ts"
import * as PnpmLock from "../src/PnpmLock.ts"

/**
 * The repository's own lockfile, the real input this scanner exists for.
 *
 * The suite parses it rather than a fixture on purpose: a fixture records what
 * the author expected pnpm to write, and this file records what pnpm wrote.
 */
const repositoryLockfile = new URL("../../../pnpm-lock.yaml", import.meta.url)

const readRepositoryLockfile = (): Promise<string> => Fs.readFile(repositoryLockfile, "utf8")

/** A lockfile that exercises every construct the scanner reports. */
const fixture = [
  "lockfileVersion: '9.0'",
  "",
  "settings:",
  "  autoInstallPeers: true",
  "  excludeLinksFromLockfile: false",
  "",
  "importers:",
  "",
  "  .:",
  "    dependencies:",
  "      left:",
  "        specifier: ^1.0.0",
  "        version: 1.0.0(right@2.0.0)",
  "    devDependencies:",
  "      '@scope/app':",
  "        specifier: workspace:*",
  "        version: link:packages/app",
  "",
  "packages:",
  "",
  "  '@scope/dep@0.1.0':",
  "    resolution: {integrity: sha512-scope==}",
  "    engines: {node: '>=22'}",
  "",
  "  left@1.0.0:",
  "    resolution: {integrity: sha512-left==}",
  "    peerDependencies:",
  "      right: ^2.0.0",
  "",
  "  opt@4.0.0:",
  "    resolution: {integrity: sha512-opt==}",
  "    os: [darwin]",
  "",
  "  right@2.0.0:",
  "    resolution: {tarball: https://example.test/right-2.0.0.tgz}",
  "",
  "  target@3.0.0:",
  "    resolution: {integrity: sha512-target==}",
  "",
  "snapshots:",
  "",
  "  '@scope/dep@0.1.0': {}",
  "",
  "  left@1.0.0(right@2.0.0):",
  "    dependencies:",
  "      '@scope/dep': 0.1.0",
  "      cva: target@3.0.0",
  "      right: 2.0.0",
  "    optionalDependencies:",
  "      opt: 4.0.0",
  "    transitivePeerDependencies:",
  "      - supports-color",
  "      - typescript",
  "",
  "  opt@4.0.0:",
  "    optional: true",
  "",
  "  right@2.0.0: {}",
  "",
  "  target@3.0.0: {}",
  ""
].join("\n")

/** Runs a refusal and returns the error it reports. */
const refusal = (source: string, options?: { readonly maximumBytes?: number }): PnpmLock.PnpmLockError =>
  Effect.runSync(Effect.flip(PnpmLock.parse(source, options ?? {})))

describe("PnpmLock.parse over the repository lockfile", () => {
  it("reports every package, snapshot, and importer the file states", async () => {
    const lockfile = PnpmLock.parseSync(await readRepositoryLockfile())
    expect(lockfile.version).toBe("9.0")
    // The file carries 1976 `packages` entries today. The assertion is a floor
    // plus a ceiling rather than the exact count, so an ordinary dependency
    // change does not fail the suite while a scanner that silently dropped
    // most of the file still does.
    expect(lockfile.packages.length).toBeGreaterThan(1500)
    expect(lockfile.packages.length).toBeLessThan(4000)
    expect(lockfile.snapshots.length).toBeGreaterThanOrEqual(lockfile.packages.length)
    expect(lockfile.importers.length).toBeGreaterThan(40)
    expect(lockfile.ignoredSections).toEqual(["settings"])
  })

  it("resolves `effect` with a version and an integrity", async () => {
    const lockfile = PnpmLock.parseSync(await readRepositoryLockfile())
    const entries = PnpmLock.packagesNamed(lockfile, "effect")
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      expect(entry.name).toBe("effect")
      expect(entry.version).toMatch(/^4\.0\.0-rc\.\d+$/)
      expect(entry.integrity).toMatch(/^sha512-/)
      expect(entry.key).toBe(`effect@${entry.version}`)
    }
    const declared = PnpmLock.packageEntry(lockfile, "effect@4.0.0-rc.108")
    expect(declared?.integrity).toMatch(/^sha512-/)
    expect(PnpmLock.packageEntry(lockfile, "effect@0.0.0-absent")).toBeUndefined()
  })

  it("resolves a sorted transitive closure that starts at the requested snapshot", async () => {
    const lockfile = PnpmLock.parseSync(await readRepositoryLockfile())
    const snapshots = PnpmLock.snapshotsNamed(lockfile, "effect")
    expect(snapshots.length).toBeGreaterThan(0)
    const identifier = snapshots[0]!.id
    const closure = Effect.runSync(PnpmLock.closure(lockfile, identifier))
    expect(closure).toContain(identifier)
    expect([...closure].sort()).toEqual([...closure])
    expect(new Set(closure).size).toBe(closure.length)
    for (const member of closure) expect(PnpmLock.snapshotEntry(lockfile, member)).toBeDefined()
  })

  it("parses to a structurally identical value twice", async () => {
    const source = await readRepositoryLockfile()
    const first = PnpmLock.parseSync(source)
    const second = PnpmLock.parseSync(source)
    expect(second).toEqual(first)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it("keeps every reported list in sorted order", async () => {
    const lockfile = PnpmLock.parseSync(await readRepositoryLockfile())
    expect(lockfile.packages.map((entry) => entry.key)).toEqual(
      [...lockfile.packages.map((entry) => entry.key)].sort()
    )
    expect(lockfile.snapshots.map((entry) => entry.id)).toEqual(
      [...lockfile.snapshots.map((entry) => entry.id)].sort()
    )
    expect(lockfile.importers.map((entry) => entry.id)).toEqual(
      [...lockfile.importers.map((entry) => entry.id)].sort()
    )
  })
})

describe("PnpmLock.parse over a stated lockfile", () => {
  const lockfile = PnpmLock.parseSync(fixture)

  it("records importer dependencies as written, without resolving them", () => {
    expect(lockfile.importers).toEqual([
      {
        id: ".",
        dependencies: [
          { group: "dependencies", name: "left", specifier: "^1.0.0", version: "1.0.0(right@2.0.0)" },
          { group: "devDependencies", name: "@scope/app", specifier: "workspace:*", version: "link:packages/app" }
        ]
      }
    ])
  })

  it("splits a scoped key into its name and its version", () => {
    expect(PnpmLock.packageEntry(lockfile, "@scope/dep@0.1.0")).toEqual({
      key: "@scope/dep@0.1.0",
      name: "@scope/dep",
      version: "0.1.0",
      integrity: "sha512-scope==",
      resolution: { integrity: "sha512-scope==" }
    })
  })

  it("reads a resolution that states no integrity", () => {
    const entry = PnpmLock.packageEntry(lockfile, "right@2.0.0")
    expect(entry?.integrity).toBeUndefined()
    expect(entry?.resolution).toEqual({ tarball: "https://example.test/right-2.0.0.tgz" })
  })

  it("reads an aliased edge under the name it resolves", () => {
    const snapshot = PnpmLock.snapshotEntry(lockfile, "left@1.0.0(right@2.0.0)")
    expect(snapshot?.packageKey).toBe("left@1.0.0")
    expect(snapshot?.dependencies).toEqual([
      { alias: "@scope/dep", name: "@scope/dep", id: "@scope/dep@0.1.0", optional: false },
      { alias: "cva", name: "target", id: "target@3.0.0", optional: false },
      { alias: "opt", name: "opt", id: "opt@4.0.0", optional: true },
      { alias: "right", name: "right", id: "right@2.0.0", optional: false }
    ])
    expect(snapshot?.transitivePeerDependencies).toEqual(["supports-color", "typescript"])
    expect(snapshot?.optional).toBe(false)
  })

  it("reads an optional snapshot and an empty one", () => {
    expect(PnpmLock.snapshotEntry(lockfile, "opt@4.0.0")?.optional).toBe(true)
    expect(PnpmLock.snapshotEntry(lockfile, "target@3.0.0")).toEqual({
      id: "target@3.0.0",
      packageKey: "target@3.0.0",
      dependencies: [],
      transitivePeerDependencies: [],
      optional: false
    })
    expect(PnpmLock.snapshotEntry(lockfile, "absent@1.0.0")).toBeUndefined()
  })

  it("names the sections it skipped", () => {
    expect(lockfile.ignoredSections).toEqual(["settings"])
  })

  it("renders a closure as stable text that names every integrity and edge", () => {
    const text = Effect.runSync(PnpmLock.closureText(lockfile, "left@1.0.0(right@2.0.0)"))
    expect(text).toBe(
      [
        "@scope/dep@0.1.0 sha512-scope==",
        "left@1.0.0(right@2.0.0) sha512-left==",
        "  @scope/dep -> @scope/dep@0.1.0",
        "  cva -> target@3.0.0",
        "  opt? -> opt@4.0.0",
        "  right -> right@2.0.0",
        "opt@4.0.0 sha512-opt==",
        "right@2.0.0 -",
        "target@3.0.0 sha512-target=="
      ].join("\n")
    )
    expect(Effect.runSync(PnpmLock.closureText(lockfile, "left@1.0.0(right@2.0.0)"))).toBe(text)
  })

  it("comes to the same closure for a cyclic graph", () => {
    const cyclic = PnpmLock.parseSync(
      [
        "lockfileVersion: '9.0'",
        "packages:",
        "  a@1.0.0:",
        "    resolution: {integrity: sha512-a==}",
        "  b@1.0.0:",
        "    resolution: {integrity: sha512-b==}",
        "snapshots:",
        "  a@1.0.0:",
        "    dependencies:",
        "      b: 1.0.0",
        "  b@1.0.0:",
        "    dependencies:",
        "      a: 1.0.0",
        ""
      ].join("\n")
    )
    expect(Effect.runSync(PnpmLock.closure(cyclic, "a@1.0.0"))).toEqual(["a@1.0.0", "b@1.0.0"])
    expect(Effect.runSync(PnpmLock.closure(cyclic, "b@1.0.0"))).toEqual(["a@1.0.0", "b@1.0.0"])
  })

  it("refuses a closure rooted at a snapshot the lockfile does not define", () => {
    const error = Effect.runSync(Effect.flip(PnpmLock.closure(lockfile, "absent@1.0.0")))
    expect(error.code).toBe("incomplete")
    expect(error.message).toContain("absent@1.0.0")
  })
})

describe("PnpmLock.parse refusals", () => {
  it("refuses a lockfile version it does not implement", () => {
    const error = refusal("lockfileVersion: '6.0'\n")
    expect(error.code).toBe("unsupported_version")
    expect(error.message).toContain("6.0")
    expect(error.line).toBe(1)
  })

  it("refuses a source that states no lockfile version", () => {
    expect(refusal("settings:\n  autoInstallPeers: true\n").code).toBe("unsupported_version")
  })

  it("refuses a source larger than the bound", () => {
    const error = refusal(fixture, { maximumBytes: 32 })
    expect(error.code).toBe("lockfile_too_large")
    expect(error.message).toContain("32")
  })

  it("bounds a source by the same constant the measure action uses", () => {
    expect(PnpmLock.maximumSourceBytes).toBe(PackageManager.maximumLockfileBytes)
  })

  it("counts the bound in UTF-8 bytes rather than in code units", () => {
    const source = `lockfileVersion: '9.0'\n\n# ${"é".repeat(8)}${String.fromCodePoint(0x1f600)}\n`
    expect(source.length).toBeLessThan(48)
    expect(refusal(source, { maximumBytes: 40 }).code).toBe("lockfile_too_large")
    expect(PnpmLock.parseSync(source, { maximumBytes: 64 }).version).toBe("9.0")
  })

  it("refuses a file truncated in the middle of a line", async () => {
    const source = await readRepositoryLockfile()
    const cut = source.indexOf("resolution: {integrity: sha512-") + 40
    const error = refusal(source.slice(0, cut))
    expect(error.code).toBe("malformed")
    expect(error.message).toContain("resolution flow map")
  })

  it("refuses a file truncated at a line boundary", async () => {
    const source = await readRepositoryLockfile()
    const lines = source.split("\n")
    const snapshots = lines.indexOf("snapshots:")
    expect(snapshots).toBeGreaterThan(0)
    // Keep every `packages` entry and half of the snapshots. Every surviving
    // line is well formed, so only the cross-section check can see the loss.
    const truncated = lines.slice(0, snapshots + Math.floor((lines.length - snapshots) / 2)).join("\n")
    const error = refusal(truncated)
    expect(error.code).toBe("incomplete")
    expect(error.message).toContain("does not define")
  })

  it("refuses a snapshot whose package the file does not define", () => {
    expect(
      refusal(
        [
          "lockfileVersion: '9.0'",
          "snapshots:",
          "  a@1.0.0: {}",
          ""
        ].join("\n")
      ).message
    ).toContain("packages section does not define")
  })

  it("refuses an edge that names a snapshot the file does not define", () => {
    expect(
      refusal(
        [
          "lockfileVersion: '9.0'",
          "packages:",
          "  a@1.0.0:",
          "    resolution: {integrity: sha512-a==}",
          "snapshots:",
          "  a@1.0.0:",
          "    dependencies:",
          "      b: 1.0.0",
          ""
        ].join("\n")
      ).message
    ).toContain("snapshots section does not define")
  })

  it("refuses tab indentation", () => {
    const error = refusal("lockfileVersion: '9.0'\npackages:\n\ta@1.0.0:\n")
    expect(error.code).toBe("malformed")
    expect(error.line).toBe(3)
  })

  it("refuses a line that is not a mapping", () => {
    expect(refusal("lockfileVersion: '9.0'\npackages\n").message).toContain("key: value")
  })

  it("refuses siblings that disagree about indentation", () => {
    const error = refusal(
      [
        "lockfileVersion: '9.0'",
        "packages:",
        "  a@1.0.0:",
        "    resolution: {integrity: sha512-a==}",
        "   b@1.0.0:",
        ""
      ].join("\n")
    )
    expect(error.code).toBe("malformed")
    expect(error.message).toContain("indentation")
  })

  it("refuses a duplicate key in every section that has one", () => {
    const duplicate = (section: string, body: ReadonlyArray<string>): string =>
      ["lockfileVersion: '9.0'", `${section}:`, ...body, ""].join("\n")
    expect(
      refusal(duplicate("packages", [
        "  a@1.0.0:",
        "    resolution: {integrity: sha512-a==}",
        "  a@1.0.0:",
        "    resolution: {integrity: sha512-a==}"
      ])).message
    ).toContain("duplicate package")
    expect(
      refusal(duplicate("snapshots", ["  a@1.0.0: {}", "  a@1.0.0: {}"])).message
    ).toContain("duplicate snapshot")
    expect(
      refusal(duplicate("importers", ["  .:", "    dependencies:", "  .:"])).message
    ).toContain("duplicate importer")
    expect(refusal("lockfileVersion: '9.0'\npackages:\npackages:\n").message).toContain("duplicate top-level")
  })

  it("refuses a file truncated after the packages section", () => {
    // Truncation at the end drops the snapshots the packages section needs.
    // Every surviving line is well formed, so only the cross-section check
    // sees the loss.
    expect(
      refusal(
        [
          "lockfileVersion: '9.0'",
          "packages:",
          "  a@1.0.0:",
          "    resolution: {integrity: sha512-a==}",
          ""
        ].join("\n")
      ).message
    ).toContain("has no snapshot")
  })

  it("refuses an inline value where a section expects a block", () => {
    expect(
      refusal("lockfileVersion: '9.0'\npackages:\n  a@1.0.0: {}\n").message
    ).toContain("has an inline value")
    expect(
      refusal(
        [
          "lockfileVersion: '9.0'",
          "packages:",
          "  a@1.0.0:",
          "    resolution: {integrity: sha512-a==}",
          "snapshots:",
          "  a@1.0.0: []",
          ""
        ].join("\n")
      ).message
    ).toContain("has an inline value")
  })

  it("refuses a snapshot field it does not implement", () => {
    expect(
      refusal(
        [
          "lockfileVersion: '9.0'",
          "packages:",
          "  a@1.0.0:",
          "    resolution: {integrity: sha512-a==}",
          "snapshots:",
          "  a@1.0.0:",
          "    invented: true",
          ""
        ].join("\n")
      ).message
    ).toContain("unsupported snapshot field")
  })

  it("refuses the malformed shapes inside a section", () => {
    const snapshot = (body: ReadonlyArray<string>): string =>
      [
        "lockfileVersion: '9.0'",
        "packages:",
        "  a@1.0.0:",
        "    resolution: {integrity: sha512-a==}",
        "snapshots:",
        "  a@1.0.0:",
        ...body,
        ""
      ].join("\n")
    expect(refusal(snapshot(["    optional: yes"])).message).toContain("boolean")
    expect(refusal(snapshot(["    transitivePeerDependencies:", "      supports-color"])).message)
      .toContain("sequence item")
    expect(refusal(snapshot(["    dependencies:", "      b:"])).message).toContain("states no version")
    expect(refusal(snapshot(["    dependencies:", "      b: 1.0.0", "        c: 2.0.0"])).message)
      .toContain("nested block")
    expect(refusal("lockfileVersion: '9.0'\npackages:\n  a:\n    resolution: {}\n").message)
      .toContain("name@version")
    expect(refusal("lockfileVersion: '9.0'\npackages:\n  a@1.0.0:\n    engines: {node: '>=22'}\n").message)
      .toContain("states no resolution")
    expect(refusal("lockfileVersion: '9.0'\npackages:\n  a@1.0.0:\n    resolution: sha512-a==\n").message)
      .toContain("resolution flow map")
    expect(
      refusal([
        "lockfileVersion: '9.0'",
        "packages:",
        "  a@1.0.0:",
        "    resolution: {integrity: sha512-a==}",
        "    resolution: {integrity: sha512-b==}",
        ""
      ].join("\n")).message
    ).toContain("two resolutions")
    expect(refusal("lockfileVersion: '9.0'\npackages: {}\n").message).toContain("has an inline value")
    expect(refusal("lockfileVersion: '9.0'\nimporters:\n  .: {}\n").message).toContain("inline value")
    expect(refusal("lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies: {}\n").message)
      .toContain("inline value")
    expect(refusal("lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      a: 1.0.0\n").message)
      .toContain("inline value")
    expect(
      refusal([
        "lockfileVersion: '9.0'",
        "importers:",
        "  .:",
        "    dependencies:",
        "      a:",
        "        specifier: ^1.0.0",
        ""
      ].join("\n")).message
    ).toContain("specifier and a version")
  })

  it("refuses the quoting and flow forms it does not implement", () => {
    const resolution = (value: string): string =>
      `lockfileVersion: '9.0'\npackages:\n  a@1.0.0:\n    resolution: ${value}\n`
    expect(refusal(resolution("{integrity: {a: b}}")).message).toContain("nested flow collection")
    expect(refusal(resolution("{integrity}")).message).toContain("without a value")
    expect(refusal(resolution("{integrity: a, integrity: b}")).message).toContain("duplicate flow map key")
    expect(refusal(resolution("{integrity: 'a}")).message).toContain("unterminated")
    expect(refusal("lockfileVersion: \"9.0\\x30\"\n").message).toContain("unsupported double-quoted scalar")
    expect(refusal("lockfileVersion: '9.0\n").message).toContain("unterminated quoted scalar")
    expect(refusal("lockfileVersion: 'it's 9'\n").message).toContain("single-quoted scalar")
  })

  it("keeps a quoted key that carries a colon or a comment marker", () => {
    const lockfile = PnpmLock.parseSync(
      [
        "lockfileVersion: '9.0' # written by pnpm",
        "packages:",
        "  'a@1.0.0':",
        "    resolution: {tarball: https://example.test/a#1.0.0.tgz}",
        "snapshots:",
        "  'a@1.0.0': {}",
        ""
      ].join("\n")
    )
    expect(lockfile.version).toBe("9.0")
    expect(PnpmLock.packageEntry(lockfile, "a@1.0.0")?.resolution).toEqual({
      tarball: "https://example.test/a#1.0.0.tgz"
    })
  })

  it("reports a refusal in the error channel rather than throwing", () => {
    const exit = Effect.runSyncExit(PnpmLock.parse("lockfileVersion: '6.0'\n"))
    expect(exit._tag).toBe("Failure")
    expect(() => PnpmLock.parseSync("lockfileVersion: '6.0'\n")).toThrow(PnpmLock.PnpmLockError)
  })

  it("parses a lockfile that states no packages at all", () => {
    const empty = PnpmLock.parseSync("lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n")
    expect(empty).toEqual({
      version: "9.0",
      importers: [{ id: ".", dependencies: [] }],
      packages: [],
      snapshots: [],
      ignoredSections: []
    })
  })
})

describe("PnpmLock.read", () => {
  const withRoot = async <A>(use: (root: string) => Promise<A>): Promise<A> => {
    const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-pnpm-lock-")))
    try {
      return await use(root)
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  }

  const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect)

  it("reads and parses a lockfile from disk", async () => {
    await withRoot(async (root) => {
      const path = NodePath.join(root, "pnpm-lock.yaml")
      await Fs.writeFile(path, fixture, "utf8")
      const lockfile = await run(PnpmLock.read(path).pipe(Effect.provide(NodeServices.layer)))
      expect(lockfile.packages.map((entry) => entry.key)).toEqual([
        "@scope/dep@0.1.0",
        "left@1.0.0",
        "opt@4.0.0",
        "right@2.0.0",
        "target@3.0.0"
      ])
    })
  })

  it("refuses a path that is not a regular file", async () => {
    await withRoot(async (root) => {
      const error = await run(
        Effect.flip(PnpmLock.read(root).pipe(Effect.provide(NodeServices.layer)))
      )
      expect(error.code).toBe("lockfile_unreadable")
      expect(error.message).toContain("not a regular file")
    })
  })

  it("refuses a path that does not exist", async () => {
    await withRoot(async (root) => {
      const error = await run(
        Effect.flip(
          PnpmLock.read(NodePath.join(root, "absent.yaml")).pipe(Effect.provide(NodeServices.layer))
        )
      )
      expect(error.code).toBe("lockfile_unreadable")
    })
  })

  it("refuses a file larger than the bound before it reads it", async () => {
    await withRoot(async (root) => {
      const path = NodePath.join(root, "pnpm-lock.yaml")
      await Fs.writeFile(path, fixture, "utf8")
      const error = await run(
        Effect.flip(PnpmLock.read(path, { maximumBytes: 16 }).pipe(Effect.provide(NodeServices.layer)))
      )
      expect(error.code).toBe("lockfile_too_large")
      expect(error.message).toContain(path)
    })
  })
})
