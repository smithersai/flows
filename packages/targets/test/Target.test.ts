import * as Node from "@smthrs/plan/Node"
import * as Schema from "effect/Schema"
import { execFile } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import { StandardPackage } from "../src/StandardPackage.ts"
import * as Target from "../src/Target.ts"

const Leaf = Target.make("RuleTestLeaf", {
  attrs: Schema.Struct({}),
  kinds: ["build"],
  implementation: () => Target.notImplemented("RuleTestLeaf")
})

describe("Target metadata traversal", () => {
  it("recognizes only an own, immutable, well-formed target marker", () => {
    const target = Leaf({})
    expect(Target.isTarget(target)).toBe(true)

    let invoked = false
    const accessor = (): void => undefined
    Object.defineProperty(accessor, Target.TargetTypeId, {
      configurable: false,
      enumerable: false,
      get: () => {
        invoked = true
        return Target.metadata(target)
      }
    })
    expect(Target.isTarget(accessor)).toBe(false)
    expect(invoked).toBe(false)

    const malformed = (): void => undefined
    Object.defineProperty(malformed, Target.TargetTypeId, {
      configurable: false,
      enumerable: false,
      value: { target: "forged" },
      writable: false
    })
    expect(Target.isTarget(malformed)).toBe(false)
    expect(() => Target.metadata(malformed as never)).toThrow(/not a well-formed smithers build target/)
  })

  it("rejects target proxies without invoking their traps", () => {
    let invoked = false
    const proxy = new Proxy(Leaf({}), {
      getOwnPropertyDescriptor: () => {
        invoked = true
        return undefined
      },
      has: () => {
        invoked = true
        return true
      }
    })
    expect(Target.isTarget(proxy)).toBe(false)
    expect(invoked).toBe(false)
  })

  it("defaults arbitrary target implementations to cacheable", () => {
    expect(Target.metadata(Leaf({})).cacheable).toBe(true)
  })

  it("requires a target implementation to opt out of cache replay explicitly", () => {
    const Irreplayable = Target.make("RuleTestIrreplayable", {
      attrs: Schema.Struct({}),
      kinds: ["build"],
      cache: false,
      implementation: () => Target.notImplemented("RuleTestIrreplayable")
    })
    expect(Target.metadata(Irreplayable({})).cacheable).toBe(false)
  })

  it("records the defaulted cache decision in implementation identity", () => {
    // Both flip sites must agree. If only `cacheableFor` were flipped, a
    // defaulted rule would report `cacheable: true` while its digest still
    // recorded `["constant", false]`, so the digest would no longer identify
    // the cache decision it claims to identify.
    const implementation = () => Target.notImplemented("RuleTestDefaultedCache")
    const definition = (cache?: boolean) =>
      Target.make("RuleTestDefaultedCache", {
        attrs: Schema.Struct({}),
        kinds: ["build"],
        ...cache === undefined ? {} : { cache },
        implementation
      })

    const defaulted = Target.metadata(definition()({}))
    const optedIn = Target.metadata(definition(true)({}))
    const optedOut = Target.metadata(definition(false)({}))

    expect(defaulted.cacheable).toBe(true)
    expect(defaulted.implementationDigest).toBe(optedIn.implementationDigest)
    expect(defaulted.implementationDigest).not.toBe(optedOut.implementationDigest)
  })

  it("re-derives dependencies from verb-effective attrs", () => {
    const declared = Leaf({})
    const mapped = Leaf({})
    const Parent = Target.make("RuleTestMappedDependencies", {
      attrs: Schema.Struct({ dependency: Target.Target }),
      kinds: ["build", "lint"],
      attrsForKind: (kind, attrs) => kind === "lint" ? { dependency: mapped } : attrs,
      implementation: () => Target.notImplemented("RuleTestMappedDependencies")
    })

    const metadata = Target.metadata(Parent({ dependency: declared }))
    expect(metadata.dependencies).toEqual([declared])
    expect(metadata.forKind("build").dependencies).toEqual([declared])
    expect(metadata.forKind("lint").dependencies).toEqual([mapped])
  })

  it("does not recurse forever through a cyclic array", () => {
    const cyclic: Array<unknown> = []
    cyclic.push(cyclic)
    const Holder = Target.make("RuleTestCycle", {
      attrs: Schema.Struct({ value: Schema.Unknown }),
      kinds: ["build"],
      implementation: () => Target.notImplemented("RuleTestCycle")
    })

    expect(() => Holder({ value: cyclic })).not.toThrow()
  })

  it("refuses a Proxy without executing its traversal traps", () => {
    let invoked = false
    const proxy = new Proxy({}, {
      ownKeys: () => {
        invoked = true
        return []
      }
    })
    const Holder = Target.make("RuleTestProxy", {
      attrs: Schema.Struct({ value: Schema.Unknown }),
      kinds: ["build"],
      implementation: () => Target.notImplemented("RuleTestProxy")
    })

    expect(() => Holder({ value: proxy })).toThrow(/must not contain a Proxy/)
    expect(invoked).toBe(false)
  })

  it("changes implementation identity when a runtime contract changes", () => {
    const implementation = () => Target.notImplemented("RuleTestSchemaIdentity")
    const StringResult = Target.make("RuleTestSchemaIdentity", {
      attrs: Schema.Struct({ value: Schema.String }),
      kinds: ["build"],
      success: Schema.String,
      error: Schema.String,
      implementation
    })
    const NumberResult = Target.make("RuleTestSchemaIdentity", {
      attrs: Schema.Struct({ value: Schema.String }),
      kinds: ["build"],
      success: Schema.Number,
      error: Schema.String,
      implementation
    })

    expect(Target.metadata(StringResult({ value: "x" })).implementationDigest)
      .not.toBe(Target.metadata(NumberResult({ value: "x" })).implementationDigest)
  })

  it("changes implementation identity when cache admission policy changes", () => {
    const definition = (cache: boolean) =>
      Target.make("RuleTestCacheIdentity", {
        attrs: Schema.Struct({}),
        kinds: ["build"],
        cache,
        implementation: () => Target.notImplemented("RuleTestCacheIdentity")
      })
    expect(Target.metadata(definition(false)({})).implementationDigest)
      .not.toBe(Target.metadata(definition(true)({})).implementationDigest)
  })

  it("changes implementation identity when declared captures change", () => {
    const definition = (tool: string) =>
      Target.make("RuleTestCapturedIdentity", {
        attrs: Schema.Struct({}),
        kinds: ["build"],
        implementation: Node.capture({ tool }, () => Target.notImplemented(tool))
      })

    expect(Target.metadata(definition("first")({})).implementationDigest)
      .not.toBe(Target.metadata(definition("second")({})).implementationDigest)
  })
})

/**
 * The cache decision of every rule in the catalog, read from its source.
 *
 * A rule's cacheability is decided at `Target.make`, before any attrs exist,
 * so reading it back from a constructed target would need one valid attrs
 * record per rule. Reading the declaration states the property directly:
 * which rules name a `cache` option, and which fall through to the default.
 * The scan is exact rather than a grep, because `cache` also appears as an
 * attrs field name in `ToolBuild` and as a local in several rules.
 */
const declarations = await (async () => {
  const directory = NodePath.join(NodePath.dirname(fileURLToPath(import.meta.url)), "..", "src")
  const found: Array<{ readonly rule: string; readonly cache: string | undefined }> = []
  const names = (await Fs.readdir(directory)).filter((entry) => entry.endsWith(".ts")).sort()
  for (const name of names) {
    const source = await Fs.readFile(NodePath.join(directory, name), "utf8")
    for (const call of source.matchAll(/Target\.make\(\s*([^,]+),\s*\{\n/g)) {
      const open = call.index + call[0].length - 1
      let depth = 1
      let close = open + 1
      for (; close < source.length && depth > 0; close += 1) {
        if (source[close] === "{") depth += 1
        else if (source[close] === "}") depth -= 1
      }
      const line = source.slice(source.lastIndexOf("\n", call.index) + 1, call.index)
      const indent = " ".repeat(line.length - line.trimStart().length)
      const option = new RegExp(`^${indent}  cache: (.*?),?$`, "m").exec(source.slice(open, close))
      found.push({ rule: call[1]!.trim().replaceAll("\"", ""), cache: option?.[1] })
    }
  }
  return found
})()

/** Rules that name no `cache` option and therefore take the default. */
const defaulted = declarations.filter((entry) => entry.cache === undefined).map((entry) => entry.rule)

/** Rules that opt out of replay explicitly. */
const optedOut = declarations.filter((entry) => entry.cache === "false").map((entry) => entry.rule)

describe("the catalog's cache decisions", () => {
  it("finds every rule declaration", () => {
    expect(declarations.length).toBe(30)
  })

  it("leaves exactly nine build, test, and lint rules on the default", () => {
    // The rules the `cache: true` default made cacheable. For Typecheck,
    // Vitest, VitestCoverage, BiomeCheck, DepsLint, and PackageLint a hit is a
    // full skip: none declares outputs. DtsBuild, TsBuild, and TypedocDocs
    // declare outputs, and a hit restores those outputs from the
    // content-addressed store before it is reported.
    expect(defaulted).toEqual([
      "BiomeCheck",
      "DepsLint",
      "DtsBuild",
      "PackageLint",
      "TsBuild",
      "Typecheck",
      "TypedocDocs",
      "Vitest",
      "VitestCoverage"
    ])
  })

  it("keeps every explicit opt-out", () => {
    // The template entry is `GeneratedFile.generateFilePair`'s write half,
    // which Tsconfig, PnpmWorkspaceFile, and PackageJson's pair share.
    expect(optedOut).toEqual([
      "Changesets",
      "Clean",
      "Dev",
      "Dprint",
      "EsLint",
      "`${options.target}Write`",
      "Install",
      "JsrPublish",
      "LlmLint",
      "Lockfile",
      "NewPackage",
      "NpmPublish",
      "PackageJsonWrite",
      "SortPackageJson",
      "VitestWatch"
    ])
  })

  it("leaves the computed and explicitly cacheable rules alone", () => {
    const computed = declarations.filter((entry) =>
      entry.cache !== undefined && entry.cache !== "false" && entry.cache !== "true"
    )
    // `ruleId` is Filegroup's exported constant and `${options.target}Check`
    // is generateFilePair's check half; both are read as written.
    expect(computed.map((entry) => entry.rule)).toEqual(["GithubCiGen", "ToolBuild"])
    expect(declarations.filter((entry) => entry.cache === "true").map((entry) => entry.rule))
      .toEqual(["DocsParity", "ruleId", "`${options.target}Check`", "PackageJsonCheck"])
  })
})

describe("a cacheable test target declares its whole test directory", () => {
  let root: string

  const write = async (relative: string, text: string): Promise<void> => {
    const path = NodePath.join(root, relative)
    await Fs.mkdir(NodePath.dirname(path), { recursive: true })
    await Fs.writeFile(path, text, "utf8")
  }

  /** The package the declarations resolve against, as the planner resolves them. */
  const packageDirectory = "packages/demo"

  /** Every workspace file one target's declarations expand to. */
  const declaredFiles = async (target: Target.AnyTarget): Promise<Array<string>> => {
    const files: Array<string> = []
    for (const declaration of Target.metadata(target).inputs) {
      if (declaration._tag === "Glob") {
        files.push(...await Input.expandGlob(root, packageDirectory, declaration))
      } else if (declaration._tag === "File") {
        files.push(Input.resolvePath(packageDirectory, declaration.path))
      }
    }
    return files
  }

  /**
   * The digest of everything one target declares, which is the part of its
   * cache key a workspace edit moves.
   */
  const declaredDigest = async (target: Target.AnyTarget): Promise<string> => {
    const digests = await Input.digestFiles(root, await declaredFiles(target))
    return Input.digestText(digests.map((entry) => `${entry.path} ${entry.digest}`).join(" "))
  }

  beforeEach(async () => {
    root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-standard-package-"))
    await write("packages/demo/src/index.ts", "export const value = 1\n")
    await write("packages/demo/tsconfig.json", "{}\n")
    await write("packages/demo/tsconfig.test.json", "{}\n")
    await write("packages/demo/vitest.config.ts", "export default {}\n")
    await write("packages/demo/test/value.test.ts", "export const spec = 1\n")
    await write("packages/demo/test/MemoryHarness.ts", "export const harness = 1\n")
    await write("packages/demo/test/fixtures/stream.sse", "data: one\n")
  })

  afterEach(async () => {
    await Fs.rm(root, { force: true, recursive: true })
  })

  it("is cacheable, so an undeclared read replays a stale success", () => {
    const targets = StandardPackage({ deps: [], cwd: "packages/demo" })
    expect(Target.metadata(targets.test).cacheable).toBe(true)
    expect(Target.metadata(targets.check).cacheable).toBe(true)
    expect(Target.metadata(targets.lib).cacheable).toBe(true)
  })

  it("declares the harness and the non-TypeScript fixture", async () => {
    const files = await declaredFiles(StandardPackage({ deps: [], cwd: "packages/demo" }).test)
    expect(files).toContain("packages/demo/test/value.test.ts")
    expect(files).toContain("packages/demo/test/MemoryHarness.ts")
    expect(files).toContain("packages/demo/test/fixtures/stream.sse")
  })

  it("re-keys when a harness that is not a spec file changes", async () => {
    const test = StandardPackage({ deps: [], cwd: "packages/demo" }).test
    const before = await declaredDigest(test)
    await write("packages/demo/test/MemoryHarness.ts", "export const harness = 2\n")
    expect(await declaredDigest(test)).not.toBe(before)
  })

  it("re-keys when a fixture that is not TypeScript changes", async () => {
    const test = StandardPackage({ deps: [], cwd: "packages/demo" }).test
    const before = await declaredDigest(test)
    await write("packages/demo/test/fixtures/stream.sse", "data: two\n")
    expect(await declaredDigest(test)).not.toBe(before)
  })

  it("would not have re-keyed under the spec-file-only declaration", async () => {
    // The declaration this change widened, kept as the regression it guards:
    // a cacheable target that declares only `test` spec files reports the
    // previous run's green after a harness edit.
    const narrow = StandardPackage({
      deps: [],
      cwd: "packages/demo",
      tests: Input.glob("test/**/*.test.ts")
    }).test
    const before = await declaredDigest(narrow)
    await write("packages/demo/test/MemoryHarness.ts", "export const harness = 3\n")
    expect(await declaredDigest(narrow)).toBe(before)
  })
})

describe("implementation identity across processes", () => {
  const execFileAsync = promisify(execFile)

  it("digests the same declaration identically in two cold processes", async () => {
    // A cacheable rule replays across runs, so its digest must be a function
    // of the workspace, not of the process that planned it. The entropy
    // `Node.functionIdentity` adds to an unannotated closure is per-process:
    // folded into `implementationDigest` it re-keys every target on every cold
    // start and no stored entry is ever hit. An in-process assertion cannot
    // see that, so the declaration is planned in two fresh processes.
    const targetModule = pathToFileURL(
      NodePath.join(NodePath.dirname(fileURLToPath(import.meta.url)), "..", "src", "Target.ts")
    ).href
    const probe = `
      import { createRequire } from "node:module"
      const require = createRequire(${JSON.stringify(targetModule)})
      const Schema = await import(require.resolve("effect/Schema"))
      const Target = await import(${JSON.stringify(targetModule)})
      const Leaf = Target.make("RuleTestCrossProcess", {
        attrs: Schema.Struct({}),
        kinds: ["build"],
        implementation: () => Target.notImplemented("RuleTestCrossProcess")
      })
      process.stdout.write(Target.metadata(Leaf({})).implementationDigest)
    `
    const plan = () =>
      execFileAsync(process.execPath, ["--input-type=module", "--eval", probe], { maxBuffer: 4 * 1024 * 1024 })
    const [first, second] = await Promise.all([plan(), plan()])
    expect(first.stdout).toMatch(/^[0-9a-f]{64}$/)
    expect(second.stdout).toBe(first.stdout)
  }, 60_000)
})
