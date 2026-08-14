import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as KernelFileSystem from "@smthrs/kernel-next/FileSystem"
import * as GrantStore from "@smthrs/kernel-next/GrantStore"
import * as Workspace from "@smthrs/kernel-next/Workspace"
import { Effect, Fiber, FileSystem, Layer, Path } from "effect"
import { execFile } from "node:child_process"
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import * as AtomicFileSystem from "../src/AtomicFileSystem.ts"

const directories = new Set<string>()

const temporaryDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), "flows-node-atomic-"))
  directories.add(directory)
  return directory
}

afterEach(async () => {
  await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })))
  directories.clear()
})

const guarded = (root: string, host: Layer.Layer<FileSystem.FileSystem> = AtomicFileSystem.layer) =>
  KernelFileSystem.layer.pipe(
    Layer.provide(host),
    Layer.provide(Path.layer),
    Layer.provide(Workspace.layer(root)),
    Layer.provide(GrantStore.layerNoop)
  )

const swappingHost = (swap: () => Promise<void>) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem
      const atomic = (fileSystem as KernelFileSystem.AtomicHostFileSystem)[KernelFileSystem.AtomicFileSystemTypeId]
      let swapped = false
      return KernelFileSystem.withAtomicFileSystem(fileSystem, {
        execute: <A>(request: KernelFileSystem.AtomicRequest) =>
          Effect.promise(async () => {
            if (!swapped) {
              swapped = true
              await swap()
            }
          }).pipe(Effect.andThen(atomic.execute<A>(request)))
      })
    })
  ).pipe(Layer.provide(AtomicFileSystem.layer))

const run = <A, E>(root: string, effect: Effect.Effect<A, E, FileSystem.FileSystem>, host = AtomicFileSystem.layer) =>
  Effect.runPromise(effect.pipe(Effect.provide(guarded(root, host))))

describe("Node atomic filesystem", () => {
  it("executes every descriptor-relative operation without path re-resolution", async () => {
    const root = await temporaryDirectory()
    const outcome = await run(
      root,
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const nested = join(root, "nested")
        const text = join(nested, "text.txt")
        const bytes = join(nested, "bytes.bin")
        const link = join(root, "text-link")
        const renamed = join(nested, "renamed.txt")
        yield* fs.makeDirectory(nested, { recursive: true })
        yield* fs.writeFileString(text, "hello")
        yield* fs.writeFile(bytes, new Uint8Array([1, 2, 3]))
        const textValue = yield* fs.readFileString(text)
        const bytesValue = yield* fs.readFile(bytes)
        const present = yield* fs.exists(text)
        const absent = yield* fs.exists(join(root, "missing.txt"))
        yield* Effect.promise(() => symlink("nested/text.txt", link))
        const linkTarget = yield* fs.readLink(link)
        yield* Effect.promise(() => rm(link))
        const real = yield* fs.realPath(text)
        const info = yield* fs.stat(text)
        const entries = yield* fs.readDirectory(root, { recursive: true })
        const matches = yield* fs.glob("**/*.txt", { root })
        yield* fs.rename(text, renamed)
        yield* fs.remove(nested, { recursive: true })
        return { absent, bytesValue: [...bytesValue], entries, info, linkTarget, matches, present, real, textValue }
      })
    )

    expect(outcome).toMatchObject({
      absent: false,
      bytesValue: [1, 2, 3],
      linkTarget: "nested/text.txt",
      present: true,
      textValue: "hello"
    })
    expect(outcome.real).toMatch(/nested\/text\.txt$/)
    expect(outcome.info.type).toBe("File")
    expect(outcome.entries).toContain("nested/text.txt")
    expect(outcome.matches).toEqual([join(root, "nested/text.txt")])
  }, 30_000)

  it("rejects every operation when an intermediate component is swapped after authorization", async () => {
    const operations = [
      (fs: FileSystem.FileSystem, path: string, root: string) => fs.readFile(path),
      (fs: FileSystem.FileSystem, path: string) => fs.writeFile(path, new Uint8Array([9])),
      (fs: FileSystem.FileSystem, path: string) => fs.writeFileString(path, "escaped"),
      (fs: FileSystem.FileSystem, path: string) => fs.makeDirectory(join(path, "child")),
      (fs: FileSystem.FileSystem, path: string) => fs.remove(path),
      (fs: FileSystem.FileSystem, path: string, root: string) => fs.rename(path, join(root, "renamed.txt")),
      (fs: FileSystem.FileSystem, _path: string, _root: string, gate: string) => fs.readDirectory(gate),
      (fs: FileSystem.FileSystem, path: string) => fs.stat(path)
    ] as const

    for (const operation of operations) {
      const directory = await temporaryDirectory()
      const root = join(directory, "workspace")
      const outside = join(directory, "outside")
      const gate = join(root, "gate")
      const parked = join(root, "parked")
      const target = join(gate, "victim.txt")
      const outsideVictim = join(outside, "victim.txt")
      await mkdir(gate, { recursive: true })
      await mkdir(outside)
      await writeFile(target, "inside")
      await writeFile(outsideVictim, "outside")
      const result = await run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          return yield* Effect.result(operation(fs, target, root, gate))
        }),
        swappingHost(async () => {
          await rename(gate, parked)
          await symlink(outside, gate)
        })
      )
      expect(result._tag).toBe("Failure")
      expect(await readFile(outsideVictim, "utf8")).toBe("outside")
    }
  }, 30_000)

  /**
   * Listing is the one family that must not simply fail: it resolves nothing,
   * so the property to pin is that no path behind the planted link is ever
   * reported, not that the call errors.
   */
  it("reports nothing behind an intermediate component swapped to an outside directory", async () => {
    const directory = await temporaryDirectory()
    const root = join(directory, "workspace")
    const outside = join(directory, "outside")
    const gate = join(root, "gate")
    const parked = join(root, "parked")
    await mkdir(gate, { recursive: true })
    await mkdir(outside)
    await writeFile(join(gate, "victim.txt"), "inside")
    await writeFile(join(outside, "victim.txt"), "outside")

    const result = await run(
      root,
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        return {
          listing: yield* Effect.result(fs.readDirectory(gate)),
          rootedGlob: yield* Effect.result(fs.glob("**", { root: gate })),
          matched: yield* fs.glob("gate/**", { root }),
          everything: yield* fs.readDirectory(root, { recursive: true })
        }
      }),
      swappingHost(async () => {
        await rename(gate, parked)
        await symlink(outside, gate)
      })
    )

    // Opening the swapped directory itself still fails closed, whether it is
    // named as the listing target or as a glob root.
    expect(result.listing._tag).toBe("Failure")
    expect(result.rootedGlob._tag).toBe("Failure")
    expect(result.matched).toEqual([])
    expect(result.everything).toContain("gate")
    expect(result.everything.some((entry) => entry.startsWith("gate/"))).toBe(false)
    expect(await readFile(join(outside, "victim.txt"), "utf8")).toBe("outside")
  })

  it("rejects final-component swaps for file, directory, and rename sources", async () => {
    const operations = [
      (fs: FileSystem.FileSystem, path: string, root: string) => fs.readFile(path),
      (fs: FileSystem.FileSystem, path: string) => fs.writeFile(path, new Uint8Array([9])),
      (fs: FileSystem.FileSystem, path: string) => fs.writeFileString(path, "escaped"),
      (fs: FileSystem.FileSystem, path: string) => fs.remove(path),
      (fs: FileSystem.FileSystem, path: string, root: string) => fs.rename(path, join(root, "renamed.txt")),
      (fs: FileSystem.FileSystem, path: string) => fs.stat(path)
    ] as const

    for (const operation of operations) {
      const directory = await temporaryDirectory()
      const root = join(directory, "workspace")
      const outside = join(directory, "outside")
      const target = join(root, "target.txt")
      const parked = join(root, "parked.txt")
      const outsideVictim = join(outside, "victim.txt")
      await mkdir(root)
      await mkdir(outside)
      await writeFile(target, "inside")
      await writeFile(outsideVictim, "outside")
      const result = await run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          return yield* Effect.result(operation(fs, target, root))
        }),
        swappingHost(async () => {
          await rename(target, parked)
          await symlink(outsideVictim, target)
        })
      )
      expect(result._tag).toBe("Failure")
      expect(await readFile(outsideVictim, "utf8")).toBe("outside")
    }

    const directory = await temporaryDirectory()
    const root = join(directory, "workspace")
    const outside = join(directory, "outside")
    const target = join(root, "new-directory")
    await mkdir(root)
    await mkdir(outside)
    const result = await run(
      root,
      Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.result(fs.makeDirectory(target))),
      swappingHost(() => symlink(outside, target))
    )
    expect(result._tag).toBe("Failure")

    const container = await temporaryDirectory()
    const workspace = join(container, "workspace")
    const outsideDirectory = join(container, "outside")
    const directoryTarget = join(workspace, "target")
    const parked = join(workspace, "parked")
    await mkdir(directoryTarget, { recursive: true })
    await mkdir(outsideDirectory)
    await writeFile(join(outsideDirectory, "victim.txt"), "outside")
    const directoryResult = await run(
      workspace,
      Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.result(fs.readDirectory(directoryTarget))),
      swappingHost(async () => {
        await rename(directoryTarget, parked)
        await symlink(outsideDirectory, directoryTarget)
      })
    )
    expect(directoryResult._tag).toBe("Failure")
    expect(await readFile(join(outsideDirectory, "victim.txt"), "utf8")).toBe("outside")

    const renameContainer = await temporaryDirectory()
    const renameWorkspace = join(renameContainer, "workspace")
    const renameOutside = join(renameContainer, "outside")
    const source = join(renameWorkspace, "source.txt")
    const destination = join(renameWorkspace, "destination.txt")
    const renameVictim = join(renameOutside, "victim.txt")
    await mkdir(renameWorkspace)
    await mkdir(renameOutside)
    await writeFile(source, "inside")
    await writeFile(renameVictim, "outside")
    const renameResult = await run(
      renameWorkspace,
      Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.result(fs.rename(source, destination))),
      swappingHost(() => symlink(renameVictim, destination))
    )
    expect(renameResult._tag).toBe("Failure")
    expect(await readFile(renameVictim, "utf8")).toBe("outside")

    const hardLinkContainer = await temporaryDirectory()
    const hardLinkWorkspace = join(hardLinkContainer, "workspace")
    const hardLinkOutside = join(hardLinkContainer, "outside")
    const hardLinkTarget = join(hardLinkWorkspace, "target.txt")
    const hardLinkParked = join(hardLinkWorkspace, "parked.txt")
    const hardLinkVictim = join(hardLinkOutside, "victim.txt")
    await mkdir(hardLinkWorkspace)
    await mkdir(hardLinkOutside)
    await writeFile(hardLinkTarget, "inside")
    await writeFile(hardLinkVictim, "outside")
    const hardLinkResult = await run(
      hardLinkWorkspace,
      Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.result(fs.writeFileString(hardLinkTarget, "escaped"))),
      swappingHost(async () => {
        await rename(hardLinkTarget, hardLinkParked)
        await link(hardLinkVictim, hardLinkTarget)
      })
    )
    expect(hardLinkResult._tag).toBe("Failure")
    expect(await readFile(hardLinkVictim, "utf8")).toBe("outside")
  })

  it("names symlink entries when listing without ever descending through one", async () => {
    const directory = await temporaryDirectory()
    const root = join(directory, "workspace")
    const outside = join(directory, "outside")
    await mkdir(join(root, "real"), { recursive: true })
    await mkdir(join(outside, "hidden"), { recursive: true })
    await writeFile(join(root, "real", "kept.txt"), "inside")
    await writeFile(join(outside, "hidden", "secret.txt"), "outside")
    // A link to a directory outside the root, and a link to a file inside it.
    await symlink(outside, join(root, "escape"))
    await symlink(join(root, "real", "kept.txt"), join(root, "alias.txt"))

    const listed = await run(
      root,
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        return {
          entries: yield* fs.readDirectory(root, { recursive: true }),
          shallow: yield* fs.readDirectory(root),
          matches: yield* fs.glob("**/*.txt", { root })
        }
      })
    )

    // The links are reported by name — a listing resolves nothing.
    expect(listed.shallow).toEqual(["alias.txt", "escape", "real"])
    expect(listed.entries).toContain("escape")
    expect(listed.entries).toContain("real/kept.txt")
    // ...and nothing behind either link is ever reached.
    expect(listed.entries.some((entry) => entry.startsWith("escape/"))).toBe(false)
    expect(listed.matches).toEqual([join(root, "alias.txt"), join(root, "real/kept.txt")])
  })

  it("surfaces helper rejection as a typed platform failure", async () => {
    const root = await temporaryDirectory()
    const failure = await run(
      root,
      Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(fs.readFile(join(root, "missing.txt"))))
    )
    expect(failure).toMatchObject({ reason: { _tag: "NotFound" } })
  })

  /**
   * The interpreter is configuration, not discovery, so every unusable helper
   * is reached through the layer seam rather than by editing `PATH`.
   * `AtomicFileSystemHelper.test.ts` pins the identity and framing cases; this
   * one only pins that an unusable helper never degrades into a path-based
   * call.
   */
  it("fails closed when the configured helper is absent or exits unsuccessfully", async () => {
    const root = await temporaryDirectory()
    const bin = join(await temporaryDirectory(), "bin")
    await mkdir(bin)
    const executable = join(bin, "python3")
    const attempt = () =>
      run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.flip(fs.readFile(join(root, "missing.txt")))),
        AtomicFileSystem.layerWith({ executable })
      )

    expect(await attempt()).toMatchObject({ reason: { _tag: "PermissionDenied" } })

    await writeFile(executable, "#!/bin/sh\necho helper-failed >&2\nexit 7\n")
    await chmod(executable, 0o755)
    expect(await attempt()).toMatchObject({ reason: { _tag: "PermissionDenied" } })

    await writeFile(executable, "#!/bin/sh\nexit 7\n")
    expect(await attempt()).toMatchObject({ reason: { _tag: "PermissionDenied" } })

    await writeFile(executable, "#!/bin/sh\nprintf '{\"ok\":false}\\n'\n")
    expect(await attempt()).toMatchObject({ reason: { _tag: "PermissionDenied" } })
  })

  it("addresses the workspace root itself instead of rejecting an empty component list", async () => {
    const root = await temporaryDirectory()
    await mkdir(join(root, "kept"))
    await writeFile(join(root, "kept", "file.txt"), "inside")
    const canonical = await realpath(root)

    const outcome = await run(
      root,
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        return {
          // `join(root, ".")` normalizes to the root, so the same request
          // reaches the helper however the caller spelled it.
          dotted: yield* fs.exists(join(root, ".")),
          entries: yield* fs.readDirectory(root),
          existing: yield* fs.exists(root),
          info: yield* fs.stat(root),
          matches: yield* fs.glob("**/*.txt", { root }),
          real: yield* fs.realPath(root),
          recursiveDirectory: yield* Effect.result(fs.makeDirectory(root, { recursive: true })),
          // Everything below has to stay refused: it would either destroy or
          // move the pinned root, or read it as something it is not.
          directory: yield* Effect.flip(fs.makeDirectory(root)),
          link: yield* Effect.flip(fs.readLink(root)),
          read: yield* Effect.flip(fs.readFile(root)),
          removal: yield* Effect.flip(fs.remove(root, { recursive: true })),
          renamedAway: yield* Effect.flip(fs.rename(root, join(root, "moved"))),
          renamedOnto: yield* Effect.flip(fs.rename(join(root, "kept"), root)),
          write: yield* Effect.flip(fs.writeFileString(root, "clobbered"))
        }
      })
    )

    expect(outcome.existing).toBe(true)
    expect(outcome.dotted).toBe(true)
    expect(outcome.info.type).toBe("Directory")
    expect(outcome.entries).toEqual(["kept"])
    expect(outcome.matches).toEqual([join(root, "kept/file.txt")])
    expect(outcome.real).toBe(canonical)
    expect(outcome.recursiveDirectory._tag).toBe("Success")
    expect(outcome.directory).toMatchObject({ reason: { _tag: "AlreadyExists" } })
    expect(outcome.read).toMatchObject({ reason: { _tag: "BadResource" } })
    expect(outcome.write).toMatchObject({ reason: { _tag: "BadResource" } })
    expect(outcome.removal).toMatchObject({ reason: { _tag: "PermissionDenied" } })
    expect(outcome.renamedAway).toMatchObject({ reason: { _tag: "PermissionDenied" } })
    expect(outcome.renamedOnto).toMatchObject({ reason: { _tag: "PermissionDenied" } })
    expect(outcome.link.reason._tag).toBe("Unknown")
    // The refused operations left the root and its contents untouched.
    expect(await readFile(join(root, "kept", "file.txt"), "utf8")).toBe("inside")
  })

  it("only lets a recursive makeDirectory succeed over a real directory", async () => {
    const root = await temporaryDirectory()
    const outside = join(await temporaryDirectory(), "outside")
    await mkdir(outside)
    await writeFile(join(outside, "victim.txt"), "outside")
    await mkdir(join(root, "directory"))
    await writeFile(join(root, "file.txt"), "regular")
    await symlink(outside, join(root, "escape"))
    await symlink(join(root, "directory"), join(root, "alias"))

    const outcome = await run(
      root,
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        return {
          alias: yield* Effect.flip(fs.makeDirectory(join(root, "alias"), { recursive: true })),
          directory: yield* Effect.result(fs.makeDirectory(join(root, "directory"), { recursive: true })),
          escape: yield* Effect.flip(fs.makeDirectory(join(root, "escape"), { recursive: true })),
          file: yield* Effect.flip(fs.makeDirectory(join(root, "file.txt"), { recursive: true })),
          nestedUnderFile: yield* Effect.flip(
            fs.makeDirectory(join(root, "file.txt", "child"), { recursive: true })
          )
        }
      })
    )

    expect(outcome.directory._tag).toBe("Success")
    // An existing regular file is not a directory, so `recursive` cannot
    // absorb its EEXIST.
    expect(outcome.file).toMatchObject({ reason: { _tag: "AlreadyExists" } })
    // A symlink is refused even when it points at a directory, inside or out.
    expect(outcome.escape).toMatchObject({ reason: { _tag: "BadResource" } })
    expect(outcome.alias).toMatchObject({ reason: { _tag: "BadResource" } })
    expect(outcome.nestedUnderFile).toMatchObject({ reason: { _tag: "BadResource" } })
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("regular")
    expect(await readFile(join(outside, "victim.txt"), "utf8")).toBe("outside")
    expect(await readFile(join(root, "escape", "victim.txt"), "utf8")).toBe("outside")
  })

  it("implements every OpenFlag exactly as the native Node filesystem does", async () => {
    const flags: ReadonlyArray<FileSystem.OpenFlag> = [
      "r",
      "r+",
      "w",
      "wx",
      "w+",
      "wx+",
      "a",
      "ax",
      "a+",
      "ax+"
    ]
    const outcome = async (
      execute: (root: string, effect: Effect.Effect<boolean, never, FileSystem.FileSystem>) => Promise<boolean>,
      flag: FileSystem.OpenFlag,
      seeded: boolean
    ) => {
      const root = await temporaryDirectory()
      const target = join(root, "target.txt")
      if (seeded) await writeFile(target, "seed")
      const failed = await execute(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          Effect.match(fs.writeFileString(target, "ab", { flag }), {
            onFailure: () => true,
            onSuccess: () => false
          }))
      )
      return { content: await readFile(target, "utf8").catch(() => null), failed, flag, seeded }
    }
    const table = async (
      execute: (root: string, effect: Effect.Effect<boolean, never, FileSystem.FileSystem>) => Promise<boolean>
    ) => {
      const rows = []
      for (const flag of flags) {
        for (const seeded of [true, false]) rows.push(await outcome(execute, flag, seeded))
      }
      return rows
    }

    const atomic = await table((root, effect) => run(root, effect))
    const native = await table((_root, effect) => Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer))))
    expect(atomic).toEqual(native)

    const entry = (flag: FileSystem.OpenFlag, seeded: boolean) =>
      atomic.find((row) => row.flag === flag && row.seeded === seeded)
    // A read-only flag never writes, and never creates the file either.
    expect(entry("r", true)).toMatchObject({ content: "seed", failed: true })
    expect(entry("r", false)).toMatchObject({ content: null, failed: true })
    // `r+` requires the file and overwrites in place without truncating.
    expect(entry("r+", true)).toMatchObject({ content: "abed", failed: false })
    expect(entry("r+", false)).toMatchObject({ content: null, failed: true })
    // `w`/`w+` create and truncate; `wx`/`wx+` are exclusive.
    expect(entry("w", true)).toMatchObject({ content: "ab", failed: false })
    expect(entry("w+", true)).toMatchObject({ content: "ab", failed: false })
    expect(entry("wx", true)).toMatchObject({ content: "seed", failed: true })
    expect(entry("wx+", true)).toMatchObject({ content: "seed", failed: true })
    expect(entry("wx", false)).toMatchObject({ content: "ab", failed: false })
    // The append family never truncates, and the exclusive variants still
    // refuse an existing file.
    expect(entry("a", true)).toMatchObject({ content: "seedab", failed: false })
    expect(entry("a+", true)).toMatchObject({ content: "seedab", failed: false })
    expect(entry("a", false)).toMatchObject({ content: "ab", failed: false })
    expect(entry("ax", true)).toMatchObject({ content: "seed", failed: true })
    expect(entry("ax+", true)).toMatchObject({ content: "seed", failed: true })
    expect(entry("ax+", false)).toMatchObject({ content: "ab", failed: false })
  })

  /**
   * The helper cannot call Node's globber, so it translates the pattern into a
   * regular expression itself. That translation is only correct if it agrees
   * with the globber it replaces, exclusions included, so it is compared
   * against it rather than against a hand-written expectation.
   */
  it("selects and excludes the same paths the native globber does", async () => {
    const patterns: ReadonlyArray<readonly [string, ReadonlyArray<string> | undefined]> = [
      ["*.txt", undefined],
      ["**/*.txt", undefined],
      ["nested/*", undefined],
      ["**/*.txt", ["nested/**"]],
      ["**/*.txt", ["**/deep/**"]],
      ["nested/*", ["*.log"]],
      ["nested/*", ["nested/*.log"]],
      ["nested/?id.txt", undefined],
      ["**/*.[tl]??", undefined],
      ["**/*.[!l]??", undefined],
      ["**/*.txt", ["**"]]
    ]
    const seed = async () => {
      const root = await temporaryDirectory()
      await mkdir(join(root, "nested", "deep"), { recursive: true })
      await writeFile(join(root, "top.txt"), "")
      await writeFile(join(root, "nested", "mid.txt"), "")
      await writeFile(join(root, "nested", "deep", "low.txt"), "")
      await writeFile(join(root, "nested", "skip.log"), "")
      return root
    }
    const matches = async (
      execute: (root: string, effect: Effect.Effect<Array<string>, never, FileSystem.FileSystem>) => Promise<
        Array<string>
      >
    ) => {
      const root = await seed()
      const rows: Array<string> = []
      for (const [pattern, exclude] of patterns) {
        const found = await execute(
          root,
          Effect.flatMap(
            FileSystem.FileSystem,
            (fs) => Effect.orDie(fs.glob(join(root, pattern), exclude === undefined ? { root } : { exclude, root }))
          )
        )
        rows.push(`${pattern} !${exclude?.join(",") ?? ""} -> ${found.map((v) => relative(root, v)).sort().join(" ")}`)
      }
      return rows
    }

    expect(await matches((root, effect) => run(root, effect))).toEqual(
      await matches((_root, effect) => Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer))))
    )
  })

  it("classifies flag, encoding, and errno failures the way the native filesystem does", async () => {
    const root = await temporaryDirectory()
    const target = join(root, "target.txt")
    await writeFile(target, "seed")
    await mkdir(join(root, "occupied"))
    await writeFile(join(root, "occupied", "child.txt"), "child")
    await writeFile(join(root, "empty.txt"), "")

    const outcome = await run(
      root,
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        return {
          bytes: yield* fs.readFile(join(root, "empty.txt")),
          empty: yield* fs.readFileString(join(root, "empty.txt")),
          encoding: yield* Effect.flip(fs.readFileString(target, "not-an-encoding")),
          exclusive: yield* Effect.flip(fs.writeFileString(target, "ab", { flag: "wx" })),
          flag: yield* Effect.flip(
            fs.writeFileString(target, "ab", { flag: "nonsense" as FileSystem.OpenFlag })
          ),
          listedFile: yield* Effect.flip(fs.readDirectory(target)),
          missing: yield* Effect.flip(fs.writeFileString(join(root, "missing.txt"), "ab", { flag: "r+" })),
          notEmpty: yield* Effect.flip(fs.remove(join(root, "occupied")))
        }
      })
    )

    // An empty file decodes to an empty string, not to the helper's envelope.
    expect(outcome.empty).toBe("")
    expect([...outcome.bytes]).toEqual([])
    expect(outcome.encoding.reason).toMatchObject({
      _tag: "BadArgument",
      description: "invalid encoding",
      method: "readFileString",
      module: "FileSystem"
    })
    expect(outcome.flag.reason._tag).toBe("BadArgument")
    expect(outcome.exclusive).toMatchObject({ reason: { _tag: "AlreadyExists" } })
    expect(outcome.missing).toMatchObject({ reason: { _tag: "NotFound" } })
    expect(outcome.listedFile).toMatchObject({ reason: { _tag: "BadResource" } })
    // ENOTEMPTY has no normalized reason in Effect's own Node adapter either.
    expect(outcome.notEmpty.reason._tag).toBe("Unknown")
    expect(await readFile(target, "utf8")).toBe("seed")
  })

  /**
   * A named pipe used to read as a successful, EMPTY regular file, and a
   * write-only open of one parked the helper inside `open()` until a reader
   * arrived. `AtomicFileSystemHelper.test.ts` pins the whole special-file
   * family; this case stays here because it is the one an ordinary workspace
   * writer can plant, and it must terminate.
   */
  it("refuses a named pipe planted inside the workspace instead of waiting or reporting empty", async () => {
    const flags: ReadonlyArray<FileSystem.OpenFlag> = ["w", "a", "r+", "w+", "a+"]
    const root = await temporaryDirectory()
    const pipe = join(root, "pipe")
    // The adapter already requires python3, so this needs no new dependency.
    await promisify(execFile)(AtomicFileSystem.defaultExecutable, [
      "-I",
      "-c",
      "import os, sys; os.mkfifo(sys.argv[1])",
      pipe
    ])

    const outcome = await run(
      root,
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        return {
          existing: yield* fs.exists(pipe),
          info: yield* fs.stat(pipe),
          read: yield* Effect.flip(fs.readFile(pipe)),
          writes: yield* Effect.forEach(flags, (flag) =>
            Effect.map(
              Effect.result(fs.writeFileString(pipe, "escaped", { flag })),
              (result) => `${flag}:${result._tag}`
            )),
          // The exclusive flags refuse the existing entry before opening it.
          exclusive: yield* Effect.flip(fs.writeFileString(pipe, "escaped", { flag: "wx" }))
        }
      })
    )

    expect(outcome.existing).toBe(true)
    expect(outcome.info.type).toBe("FIFO")
    // An empty read would be indistinguishable from an empty file.
    expect(outcome.read).toMatchObject({ reason: { _tag: "PermissionDenied" } })
    expect(outcome.writes).toEqual(["w:Failure", "a:Failure", "r+:Failure", "w+:Failure", "a+:Failure"])
    expect(outcome.exclusive).toMatchObject({ reason: { _tag: "AlreadyExists" } })
    // Nothing replaced or truncated the pipe on the way through.
    const info = await lstat(pipe)
    expect(info.isFIFO()).toBe(true)
  }, 30_000)

  /**
   * `python3 -c` prepends the current working directory to `sys.path`, and the
   * cwd of a harness process is normally the very workspace this adapter
   * confines. A module planted there — or on `PYTHONPATH` — used to be
   * imported and executed inside the helper, which holds the pinned root
   * descriptor, so writing one file into the workspace bought arbitrary code
   * on the trusted side of the boundary. The proof is a planted `base64.py`
   * that both records that it ran and corrupts the read it takes part in.
   */
  it("never imports a module planted in the working directory or on PYTHONPATH", async () => {
    const root = await temporaryDirectory()
    const target = join(root, "target.txt")
    await writeFile(target, "inside")

    const plant = async (marker: string) => {
      const directory = await temporaryDirectory()
      await writeFile(
        join(directory, "base64.py"),
        `open(${JSON.stringify(marker)}, "w").write("executed")\n` +
          `def b64encode(data): return b"UFdORUQ="\n` +
          `def b64decode(data): return b"PWNED"\n`
      )
      return directory
    }
    const workingDirectoryMarker = join(await temporaryDirectory(), "cwd-executed")
    const environmentMarker = join(await temporaryDirectory(), "env-executed")
    const workingDirectory = await plant(workingDirectoryMarker)
    const environmentDirectory = await plant(environmentMarker)

    const originalCwd = process.cwd()
    const originalPythonPath = process.env.PYTHONPATH
    let bytes: Uint8Array
    try {
      process.chdir(workingDirectory)
      process.env.PYTHONPATH = environmentDirectory
      bytes = await run(
        root,
        Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFile(target))
      )
    } finally {
      process.chdir(originalCwd)
      if (originalPythonPath === undefined) delete process.env.PYTHONPATH
      else process.env.PYTHONPATH = originalPythonPath
    }

    // The real stdlib encoder ran, so the caller sees the real file...
    expect(new TextDecoder().decode(bytes)).toBe("inside")
    // ...and neither planted module was ever imported, so neither ran at all.
    expect(await readFile(workingDirectoryMarker, "utf8").catch(() => null)).toBe(null)
    expect(await readFile(environmentMarker, "utf8").catch(() => null)).toBe(null)
  })

  /**
   * The request, the response, and the bytes the syscalls receive are all
   * UTF-8, whatever locale the host was started under. Decoding the request
   * with the ambient locale used to address a DIFFERENT file for any
   * non-ASCII path and to write mojibake for any non-ASCII payload — and to
   * report success for both.
   */
  it("addresses non-ASCII paths and payloads identically under a legacy locale", async () => {
    const root = await temporaryDirectory()
    const name = "ラン.txt"
    const target = join(root, name)
    const content = "héllo — ✓"
    const overrides = { LANG: "en_US.ISO8859-1", LC_ALL: "en_US.ISO8859-1", PYTHONIOENCODING: "latin-1" }
    const original = Object.fromEntries(
      Object.keys(overrides).map((key) => [key, process.env[key]])
    )

    let outcome: { readonly entries: Array<string>; readonly text: string }
    try {
      Object.assign(process.env, overrides)
      outcome = await run(
        root,
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          yield* fs.writeFileString(target, content)
          return {
            entries: yield* fs.readDirectory(root),
            text: yield* fs.readFileString(target)
          }
        })
      )
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }

    expect(outcome.text).toBe(content)
    expect(outcome.entries).toEqual([name])
    // The bytes on disk are the ones the caller asked for, at the name the
    // caller asked for — read back outside the adapter entirely.
    expect(await readFile(target, "utf8")).toBe(content)
  })

  it("kills an in-flight helper when the Effect is interrupted", async () => {
    const root = await temporaryDirectory()
    const target = join(root, "target.txt")
    await writeFile(target, "inside")
    const bin = join(await temporaryDirectory(), "bin")
    await mkdir(bin)
    const executable = join(bin, "python3")
    await writeFile(
      executable,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e 'setTimeout(() => {}, 10000)'\n`
    )
    await chmod(executable, 0o755)
    await run(
      root,
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const fiber = yield* fs.readFile(target).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.sleep("20 millis")
        yield* Fiber.interrupt(fiber)
      }),
      AtomicFileSystem.layerWith({ executable })
    )
  })
})
