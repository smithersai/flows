import * as Schema from "effect/Schema"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as NpmLock from "../src/NpmLock.ts"
import * as Target from "../src/Target.ts"
import "./toolchain.ts"

let root: string

const write = async (relative: string, text: string): Promise<string> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
  return path
}

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-npm-lock-")))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

/**
 * A minimal pnpm 9 lockfile: `effect` depends on `leftpad`, and `unrelated`
 * shares the file without sharing the closure. The variant parameters are the
 * three knobs the digest must track.
 */
const lockfileSource = (options: {
  readonly effectVersion?: string
  readonly leftpadIntegrity?: string
  readonly unrelatedIntegrity?: string
} = {}): string => {
  const effectVersion = options.effectVersion ?? "1.0.0"
  const leftpadIntegrity = options.leftpadIntegrity ?? "sha512-leftpad"
  const unrelatedIntegrity = options.unrelatedIntegrity ?? "sha512-unrelated"
  return `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      effect:
        specifier: ${effectVersion}
        version: ${effectVersion}
      unrelated:
        specifier: 9.9.9
        version: 9.9.9

packages:

  effect@${effectVersion}:
    resolution: {integrity: sha512-effect-${effectVersion}}

  leftpad@1.0.0:
    resolution: {integrity: ${leftpadIntegrity}}

  unrelated@9.9.9:
    resolution: {integrity: ${unrelatedIntegrity}}

snapshots:

  effect@${effectVersion}:
    dependencies:
      leftpad: 1.0.0

  leftpad@1.0.0: {}

  unrelated@9.9.9: {}
`
}

const here = NodePath.dirname(fileURLToPath(import.meta.url))
const repoLockfile = NodePath.resolve(here, "../../..", "pnpm-lock.yaml")

const hexdigest = /^[0-9a-f]{64}$/

describe("NpmLock", () => {
  it("constructs the accessor without any I/O", () => {
    // A lockfile path that does not exist proves the constructor reads
    // nothing: only a call of the accessor can fail on it.
    const npm = NpmLock.NpmLock({ lockfile: Input.file(NodePath.join(root, "absent.yaml")) })
    expect(typeof npm).toBe("function")
    expect(() => npm("effect")).toThrow(/could not read/)
  })

  it("resolves a package to a declaration carrying the lockfile-derived digest", () => {
    const npm = NpmLock.NpmLock({ lockfile: Input.file(repoLockfile) })
    const declaration = npm("effect")
    expect(declaration._tag).toBe("NpmPackage")
    expect(declaration.name).toBe("effect")
    expect(declaration.versions.length).toBeGreaterThan(0)
    expect(declaration.versions.every((key) => key.startsWith("effect@"))).toBe(true)
    expect(declaration.closure).toMatch(hexdigest)
    expect(Input.isDeclared(declaration)).toBe(true)
  })

  it("refuses an unknown package at the declaration call", () => {
    const npm = NpmLock.NpmLock({ lockfile: Input.file(repoLockfile) })
    // The full message also names the declaration's BUILD.ts line when the
    // call site is a BUILD.ts frame; the scratch-workspace verification
    // exercises that path through the real CLI.
    expect(() => npm("definitely-not-a-real-package-xyz")).toThrow(
      /npm\("definitely-not-a-real-package-xyz"\) names no package in .*pnpm-lock\.yaml/
    )
  })

  it("produces the same digest for the same pinned version in two workspaces", async () => {
    const first = await write("one/pnpm-lock.yaml", lockfileSource())
    const second = await write("two/pnpm-lock.yaml", lockfileSource())
    const left = NpmLock.NpmLock({ lockfile: Input.file(first) })("effect")
    const right = NpmLock.NpmLock({ lockfile: Input.file(second) })("effect")
    expect(left.closure).toBe(right.closure)
    expect(left.versions).toEqual(["effect@1.0.0"])
  })

  it("produces a different digest for a different pinned version", async () => {
    const first = await write("one/pnpm-lock.yaml", lockfileSource())
    const second = await write("two/pnpm-lock.yaml", lockfileSource({ effectVersion: "2.0.0" }))
    const left = NpmLock.NpmLock({ lockfile: Input.file(first) })("effect")
    const right = NpmLock.NpmLock({ lockfile: Input.file(second) })("effect")
    expect(right.versions).toEqual(["effect@2.0.0"])
    expect(left.closure).not.toBe(right.closure)
  })

  it("tracks the transitive closure, not only the named entry", async () => {
    const first = await write("one/pnpm-lock.yaml", lockfileSource())
    const second = await write("two/pnpm-lock.yaml", lockfileSource({ leftpadIntegrity: "sha512-changed" }))
    const left = NpmLock.NpmLock({ lockfile: Input.file(first) })("effect")
    const right = NpmLock.NpmLock({ lockfile: Input.file(second) })("effect")
    expect(left.closure).not.toBe(right.closure)
  })
})

describe("an npm package as target key material", () => {
  // The planner keys a target on the digest `Workspace.expandDeclarations`
  // computes for each declared input, which for an `NpmPackage` declaration
  // is `NpmLock.npmPackageDigest(declaration)`. These assertions exercise
  // that exact seam without importing the planner: the digest folded into a
  // target's key is the digest compared here. One handle per lockfile
  // revision, because a handle memoizes its parse the way one CLI run does.
  const Consumer = Target.make("NpmLockTestConsumer", {
    attrs: Schema.Struct({ inputs: Schema.Array(Input.Declared) }),
    kinds: ["build"],
    implementation: () => Target.notImplemented("NpmLockTestConsumer")
  })

  const declaredDigest = (lockfile: string, name: string): string => {
    const npm = NpmLock.NpmLock({ lockfile: Input.file(lockfile) })
    const target = Consumer({ inputs: [npm(name)] })
    const found = Target.metadata(target).inputs.filter((input) => input._tag === "NpmPackage")
    expect(found.length).toBe(1)
    return NpmLock.npmPackageDigest(found[0]!)
  }

  it("collects npm(effect) as a declared input of the depending target", async () => {
    const path = await write("pnpm-lock.yaml", lockfileSource())
    expect(declaredDigest(path, "effect")).toMatch(hexdigest)
  })

  it("re-keys the target when the package's lockfile entry changes", async () => {
    const path = await write("pnpm-lock.yaml", lockfileSource())
    const initial = declaredDigest(path, "effect")
    await write("pnpm-lock.yaml", lockfileSource({ effectVersion: "2.0.0" }))
    expect(declaredDigest(path, "effect")).not.toBe(initial)
  })

  it("re-keys the target when the package's transitive closure changes", async () => {
    const path = await write("pnpm-lock.yaml", lockfileSource())
    const initial = declaredDigest(path, "effect")
    await write("pnpm-lock.yaml", lockfileSource({ leftpadIntegrity: "sha512-changed" }))
    expect(declaredDigest(path, "effect")).not.toBe(initial)
  })

  it("keeps the target's key when an unrelated lockfile entry changes", async () => {
    const path = await write("pnpm-lock.yaml", lockfileSource())
    const initial = declaredDigest(path, "effect")
    await write("pnpm-lock.yaml", lockfileSource({ unrelatedIntegrity: "sha512-moved" }))
    expect(declaredDigest(path, "effect")).toBe(initial)
  })
})
