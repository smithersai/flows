import * as ArtifactStore from "@smthrs/artifacts-next/ArtifactStore"
import type { FileBoundary } from "@smthrs/flow-next/FileBoundary"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import { describe, expect, it } from "vitest"
import * as StepBoundary from "../src/StepBoundary.ts"

/**
 * The production boundary now needs an `ArtifactStore` as well as a
 * `FileSystem`: blob mechanics moved to `@smthrs/artifacts-next`.
 */
const hostLayer = (fs: FileSystem.FileSystem) =>
  ArtifactStore.layerFileSystem().pipe(Layer.provideMerge(Layer.succeed(FileSystem.FileSystem)(fs)))
import { runPromise, sha256 } from "./Sha256.ts"

const descriptor: FileBoundary = {
  readSet: [{ path: "input.txt", digest: "a" }],
  writeSet: ["output.txt"],
  boundaryMode: "hard"
}

describe("StepBoundary", () => {
  it("fails hard mode for an undeclared write", async () => {
    const program = Effect.gen(function*() {
      const boundary = yield* StepBoundary.StepBoundary
      const prepared = yield* boundary.prepare(descriptor)
      return yield* Effect.flip(boundary.settle(prepared))
    }).pipe(Effect.provide(StepBoundary.layerTest({ changedPaths: ["surprise.txt"], diffIdentity: "d1" })))
    await expect(runPromise(program)).resolves.toMatchObject({
      _tag: "flows/engine-store/UndeclaredWrite",
      code: "undeclared_write",
      paths: ["surprise.txt"],
      diffIdentity: "d1"
    })
  })

  it("records expected-mode deviations", async () => {
    const program = Effect.gen(function*() {
      const boundary = yield* StepBoundary.StepBoundary
      const prepared = yield* boundary.prepare({ ...descriptor, boundaryMode: "expected" })
      return yield* boundary.settle(prepared)
    }).pipe(Effect.provide(StepBoundary.layerTest({ changedPaths: ["surprise.txt"], diffIdentity: "d2" })))
    await expect(runPromise(program)).resolves.toMatchObject({
      declaredOutputs: { paths: ["output.txt"] },
      deviation: { _tag: "ExpectedSetDeviation", paths: ["surprise.txt"], diffIdentity: "d2" }
    })
  })

  it("recognizes tree and glob coverage in the deterministic whole-tree fixture", async () => {
    const program = Effect.gen(function*() {
      const boundary = yield* StepBoundary.StepBoundary
      const prepared = yield* boundary.prepare({
        readSet: [],
        writeSet: [
          { _tag: "TreeArtifact", path: "tree" },
          { _tag: "Glob", include: ["generated/**/*.js"] }
        ],
        boundaryMode: "hard"
      })
      return yield* boundary.settle(prepared)
    }).pipe(Effect.provide(StepBoundary.layerTest({
      changedPaths: ["tree/a.txt", "generated/nested/a.js"],
      hermeticReadDetection: false
    })))
    await expect(runPromise(program)).resolves.toMatchObject({ wholeTreeWritesVerified: true })
  })

  it("captures outputs and re-materializes them on replay", async () => {
    const replayed: Array<StepBoundary.BoundaryEvidence> = []
    const layer = StepBoundary.layerTest({
      declaredOutputs: { output: "value" },
      onReplay: (evidence) => replayed.push(evidence)
    })
    const program = Effect.gen(function*() {
      const boundary = yield* StepBoundary.StepBoundary
      const prepared = yield* boundary.prepare(descriptor)
      const evidence = yield* boundary.settle(prepared)
      yield* boundary.replayOutputs(evidence)
      return evidence
    }).pipe(Effect.provide(layer))
    await expect(runPromise(program)).resolves.toMatchObject({ declaredOutputs: { output: "value" } })
    expect(replayed).toHaveLength(1)
  })

  it("fails hard mode for a declared output the step never produced", async () => {
    const program = Effect.gen(function*() {
      const boundary = yield* StepBoundary.StepBoundary
      const prepared = yield* boundary.prepare(descriptor)
      return yield* Effect.flip(boundary.settle(prepared))
    }).pipe(Effect.provide(StepBoundary.layerTest({ missingOutputs: ["output.txt"], diffIdentity: "d4" })))
    await expect(runPromise(program)).resolves.toMatchObject({
      _tag: "flows/engine-store/MissingDeclaredOutput",
      code: "missing_declared_output",
      paths: ["output.txt"],
      diffIdentity: "d4"
    })
  })

  it("records a missing declared output as an expected-mode deviation", async () => {
    const program = Effect.gen(function*() {
      const boundary = yield* StepBoundary.StepBoundary
      const prepared = yield* boundary.prepare({ ...descriptor, boundaryMode: "expected" })
      return yield* boundary.settle(prepared)
    }).pipe(Effect.provide(StepBoundary.layerTest({ missingOutputs: ["output.txt"], diffIdentity: "d5" })))
    // A deviation of ANY variant bars the evidence from the shared cache —
    // `ActionPersistence` gates `recordCache` on `deviation === undefined` —
    // so an unexplained absence never reaches another host in either mode.
    await expect(runPromise(program)).resolves.toMatchObject({
      deviation: { _tag: "MissingDeclaredOutput", paths: ["output.txt"], diffIdentity: "d5" }
    })
  })

  it("legalizes an absence the boundary declared as a removal", async () => {
    const program = Effect.gen(function*() {
      const boundary = yield* StepBoundary.StepBoundary
      const prepared = yield* boundary.prepare({
        ...descriptor,
        writeSet: ["output.txt"],
        removes: ["stale.txt"]
      })
      return yield* boundary.settle(prepared)
    }).pipe(Effect.provide(StepBoundary.layerTest({ missingOutputs: ["stale.txt"], changedPaths: ["stale.txt"] })))
    const evidence = await runPromise(program)
    expect(evidence.deviation).toBeUndefined()
  })

  it("hard-fails a surviving removal the fixture reports", async () => {
    const program = Effect.gen(function*() {
      const boundary = yield* StepBoundary.StepBoundary
      const prepared = yield* boundary.prepare({
        ...descriptor,
        writeSet: ["output.txt"],
        removes: ["stale.txt"]
      })
      return yield* Effect.flip(boundary.settle(prepared))
    }).pipe(Effect.provide(StepBoundary.layerTest({ survivingRemovals: ["stale.txt"] })))
    const failure = await runPromise(program)
    expect(failure).toMatchObject({
      _tag: "flows/engine-store/SurvivingDeclaredRemoval",
      code: "surviving_declared_removal",
      paths: ["stale.txt"]
    })
  })

  it("records a fixture-reported surviving removal as a deviation in expected mode", async () => {
    const program = Effect.gen(function*() {
      const boundary = yield* StepBoundary.StepBoundary
      const prepared = yield* boundary.prepare({
        ...descriptor,
        boundaryMode: "expected",
        writeSet: ["output.txt"],
        removes: ["stale.txt"]
      })
      return yield* boundary.settle(prepared)
    }).pipe(Effect.provide(StepBoundary.layerTest({ survivingRemovals: ["stale.txt"] })))
    const evidence = await runPromise(program)
    expect(evidence.deviation).toMatchObject({ _tag: "SurvivingDeclaredRemoval", paths: ["stale.txt"] })
  })

  it("fails closed when the host does not support boundaries", async () => {
    const program = Effect.gen(function*() {
      const boundary = yield* StepBoundary.StepBoundary
      return yield* Effect.flip(boundary.prepare(descriptor))
    }).pipe(Effect.provide(StepBoundary.layerTest({ supported: false })))
    await expect(runPromise(program)).resolves.toMatchObject({
      _tag: "flows/engine-store/UnsupportedBoundary",
      code: "unsupported_boundary"
    })
  })

  it("fails closed during settlement and output replay", async () => {
    const program = Effect.gen(function*() {
      const boundary = yield* StepBoundary.StepBoundary
      const prepared: StepBoundary.PreparedBoundary = { descriptor, readSnapshot: StepBoundary.exactReads(descriptor) }
      const settle = yield* Effect.flip(boundary.settle(prepared))
      const replay = yield* Effect.flip(boundary.replayOutputs({ declaredOutputs: {}, diffIdentity: "d3" }))
      return [settle, replay]
    }).pipe(Effect.provide(StepBoundary.layerTest({ supported: false })))
    await expect(runPromise(program)).resolves.toHaveLength(2)
  })
})

/**
 * The filesystem-backed production layer (issue #104): until this layer the
 * only implementation was `layerTest`, whose `prepare` defaulted the read
 * snapshot to the declaration — so outside tests the issue-#90 dirty check
 * compared the declaration against itself and passed unconditionally, and a
 * hard-boundary application had no service to provide at all.
 */
describe("StepBoundary.layer (filesystem-backed)", () => {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  /** A deterministic in-memory host filesystem over the kernel seam. */
  const memoryFs = (seed: Record<string, string>) => {
    const files = new Map<string, Uint8Array>(
      Object.entries(seed).map(([path, content]) => [path, encoder.encode(content)])
    )
    const directories = new Set<string>()
    const addParentDirectories = (path: string) => {
      const segments = path.split("/")
      for (let index = 1; index < segments.length; index++) {
        directories.add(segments.slice(0, index).join("/"))
      }
    }
    for (const path of files.keys()) addParentDirectories(path)
    const failedReads = new Set<string>()
    const madeDirectories: Array<string> = []
    const removals: Array<string> = []
    const writes: Array<string> = []
    const present = (path: string) =>
      files.has(path) ||
      directories.has(path) ||
      [...files.keys(), ...directories].some((candidate) => candidate.startsWith(`${path}/`))
    const fs = FileSystem.makeNoop({
      exists: ((path: string) => Effect.succeed(present(path))) as never,
      readFile: ((path: string) =>
        Effect.suspend(() => {
          if (failedReads.delete(path)) return Effect.fail(new Error(`EIO: ${path}`))
          const bytes = files.get(path)
          return bytes === undefined ? Effect.fail(new Error(`ENOENT: ${path}`)) : Effect.succeed(bytes)
        })) as never,
      writeFile: ((path: string, bytes: Uint8Array) =>
        Effect.sync(() => {
          writes.push(path)
          addParentDirectories(path)
          files.set(path, bytes)
        })) as never,
      remove: ((path: string, options?: { readonly recursive?: boolean }) =>
        Effect.suspend(() => {
          const descendantFiles = [...files.keys()].filter((candidate) => candidate.startsWith(`${path}/`))
          const descendantDirectories = [...directories].filter((candidate) => candidate.startsWith(`${path}/`))
          if (
            files.has(path) === false &&
            options?.recursive !== true &&
            (descendantFiles.length > 0 || descendantDirectories.length > 0)
          ) return Effect.fail(new Error(`ENOTEMPTY: ${path}`))
          return Effect.sync(() => {
            removals.push(path)
            files.delete(path)
            directories.delete(path)
            if (options?.recursive !== true) return
            for (const candidate of files.keys()) {
              if (candidate.startsWith(`${path}/`)) files.delete(candidate)
            }
            for (const candidate of directories) {
              if (candidate.startsWith(`${path}/`)) directories.delete(candidate)
            }
          })
        })) as never,
      makeDirectory: ((path: string, options?: { readonly recursive?: boolean }) =>
        Effect.sync(() => {
          madeDirectories.push(path)
          if (options?.recursive !== true) {
            directories.add(path)
            return
          }
          const segments = path.split("/")
          for (let index = 1; index <= segments.length; index++) {
            directories.add(segments.slice(0, index).join("/"))
          }
        })) as never,
      // Node-faithful: a recursive listing names intermediate directories
      // too, and `stat` answers `Directory` for them — the walk skips or
      // collects them exactly as it does over a real host. Directories with
      // no files exist only in the `directories` set, so listings draw from
      // both; a missing or non-directory path answers ENOENT as a host does.
      readDirectory: ((directory: string, options?: { readonly recursive?: boolean }) =>
        Effect.suspend(() => {
          const root = directory === "."
          if (!root && (!present(directory) || files.has(directory))) {
            return Effect.fail(new Error(`ENOENT: ${directory}`))
          }
          const prefix = root ? "" : `${directory}/`
          const entries = new Set<string>()
          for (const candidate of [...directories, ...files.keys()]) {
            if (prefix !== "" && !candidate.startsWith(prefix)) continue
            const relative = prefix === "" ? candidate : candidate.slice(prefix.length)
            entries.add(options?.recursive === true ? relative : relative.split("/")[0]!)
          }
          return Effect.succeed([...entries].sort())
        })) as never,
      stat: ((path: string) =>
        files.has(path)
          ? Effect.succeed({ type: "File" })
          : present(path)
          ? Effect.succeed({ type: "Directory" })
          : Effect.fail(new Error(`ENOENT: ${path}`))) as never
    })
    return {
      directories,
      failedReads,
      files,
      fs,
      madeDirectories,
      removals,
      writes,
      layer: StepBoundary.layer.pipe(Layer.provide(hostLayer(fs)))
    }
  }

  const declared = (content: string): FileBoundary => ({
    readSet: [{ path: "input.txt", digest: sha256(content) }],
    writeSet: ["output.txt"],
    boundaryMode: "hard"
  })

  it("measures the declared read set for real instead of echoing the declaration", async () => {
    const host = memoryFs({ "input.txt": "post-edit content" })
    const prepared = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        return yield* boundary.prepare(declared("pre-edit content"))
      }).pipe(Effect.provide(host.layer))
    )
    // The stale declaration must be refused: the measured digest differs.
    expect(StepBoundary.readSetMatches(prepared)).toBe(false)
    expect(prepared.readSnapshot[0]!.digest).toBe(sha256("post-edit content"))
  })

  it("accepts a declaration that still matches the measured files", async () => {
    const host = memoryFs({ "input.txt": "stable content" })
    const prepared = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        return yield* boundary.prepare(declared("stable content"))
      }).pipe(Effect.provide(host.layer))
    )
    expect(StepBoundary.readSetMatches(prepared)).toBe(true)
  })

  it("expands read globs deterministically but refuses an unkeyed direct cache hit", async () => {
    const host = memoryFs({
      "src/a.ts": "a",
      "src/nested/b.ts": "b",
      "src/skip.js": "skip"
    })
    const prepared = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        return yield* boundary.prepare({
          readSet: [{ _tag: "Glob", include: ["src/**/*.ts"] }],
          writeSet: [],
          boundaryMode: "hard"
        })
      }).pipe(Effect.provide(host.layer))
    )
    expect(prepared.readSnapshot.map((entry) => entry.path)).toEqual(["src/a.ts", "src/nested/b.ts"])
    // PlanScheduler replaces source globs with this exact measured snapshot
    // before keying. A direct action retains the pattern, so it cannot prove
    // that the snapshot was folded into its key and must miss conservatively.
    expect(StepBoundary.readSetMatches(prepared)).toBe(false)
  })

  it("reports a vanished declared read as a mismatch", async () => {
    const host = memoryFs({})
    const prepared = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        return yield* boundary.prepare(declared("was here"))
      }).pipe(Effect.provide(host.layer))
    )
    expect(StepBoundary.readSetMatches(prepared)).toBe(false)
  })

  it("fails a hard boundary whose declared read was mutated outside the write set", async () => {
    const host = memoryFs({ "input.txt": "original" })
    const failure = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        const prepared = yield* boundary.prepare(declared("original"))
        // The body mutates a declared read that is not a declared write.
        host.files.set("input.txt", encoder.encode("scribbled"))
        return yield* Effect.flip(boundary.settle(prepared))
      }).pipe(Effect.provide(host.layer))
    )
    expect(failure).toMatchObject({
      _tag: "flows/engine-store/UndeclaredWrite",
      code: "undeclared_write",
      paths: ["input.txt"]
    })
  })

  it("records the mutation as a deviation under an expected boundary", async () => {
    const host = memoryFs({ "input.txt": "original" })
    const evidence = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        const prepared = yield* boundary.prepare({ ...declared("original"), boundaryMode: "expected" })
        host.files.set("input.txt", encoder.encode("scribbled"))
        return yield* boundary.settle(prepared)
      }).pipe(Effect.provide(host.layer))
    )
    expect(evidence.deviation).toMatchObject({ _tag: "ExpectedSetDeviation", paths: ["input.txt"] })
  })

  it("hard-fails a declared output the body never produced", async () => {
    // Bazel's `checkOutputs`. Recording the absence as `digest: null` would
    // cache the claim "this file should not exist", and every later
    // `replayOutputs` would act on it by DELETING the path on a workspace that
    // never ran the step — a crash mid-body would poison the cache with an
    // eraser.
    const host = memoryFs({ "input.txt": "original" })
    const failure = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        const prepared = yield* boundary.prepare(declared("original"))
        // The body never wrote `output.txt`.
        return yield* Effect.flip(boundary.settle(prepared))
      }).pipe(Effect.provide(host.layer))
    )
    expect(failure).toMatchObject({
      _tag: "flows/engine-store/MissingDeclaredOutput",
      code: "missing_declared_output",
      paths: ["output.txt"]
    })
  })

  it("records the absence as a deviation under an expected boundary", async () => {
    const host = memoryFs({ "input.txt": "original" })
    const evidence = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        const prepared = yield* boundary.prepare({ ...declared("original"), boundaryMode: "expected" })
        return yield* boundary.settle(prepared)
      }).pipe(Effect.provide(host.layer))
    )
    expect(evidence.deviation).toMatchObject({ _tag: "MissingDeclaredOutput", paths: ["output.txt"] })
  })

  it("legalizes a declared removal, and replay still deletes it", async () => {
    const producer = memoryFs({ "input.txt": "original", "stale.txt": "obsolete" })
    const evidence = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        const prepared = yield* boundary.prepare({
          ...declared("original"),
          writeSet: ["output.txt"],
          removes: ["stale.txt"]
        })
        producer.files.set("output.txt", encoder.encode("built"))
        producer.files.delete("stale.txt")
        return yield* boundary.settle(prepared)
      }).pipe(Effect.provide(producer.layer))
    )
    // Declared, therefore evidence rather than a defect — and it keeps the
    // `digest: null` capture that makes replay delete the path.
    expect(evidence.deviation).toBeUndefined()

    const consumer = memoryFs({ "stale.txt": "still here" })
    await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        yield* boundary.replayOutputs(evidence)
      }).pipe(Effect.provide(consumer.layer))
    )
    expect(consumer.files.has("stale.txt")).toBe(false)
    expect(decoder.decode(consumer.files.get("output.txt"))).toBe("built")
  })

  it("hard-fails a declared removal the body left in place", async () => {
    // The dual of the missing-output rule: `removes` promises the post-state.
    // A path that survived — here, quietly rewritten — must not settle as
    // evidence, or the mutation is cached under a declaration that disclaimed
    // it and replay materializes it everywhere.
    const host = memoryFs({ "input.txt": "original", "stale.txt": "obsolete" })
    const failure = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        const prepared = yield* boundary.prepare({
          ...declared("original"),
          writeSet: ["output.txt"],
          removes: ["stale.txt"]
        })
        host.files.set("output.txt", encoder.encode("built"))
        host.files.set("stale.txt", encoder.encode("mutated, not deleted"))
        return yield* Effect.flip(boundary.settle(prepared))
      }).pipe(Effect.provide(host.layer))
    )
    expect(failure).toMatchObject({
      _tag: "flows/engine-store/SurvivingDeclaredRemoval",
      code: "surviving_declared_removal",
      paths: ["stale.txt"]
    })
  })

  it("records a surviving removal as a deviation under an expected boundary", async () => {
    const host = memoryFs({ "input.txt": "original", "stale.txt": "obsolete" })
    const evidence = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        const prepared = yield* boundary.prepare({
          ...declared("original"),
          boundaryMode: "expected",
          writeSet: ["output.txt"],
          removes: ["stale.txt"]
        })
        host.files.set("output.txt", encoder.encode("built"))
        return yield* boundary.settle(prepared)
      }).pipe(Effect.provide(host.layer))
    )
    expect(evidence.deviation).toMatchObject({ _tag: "SurvivingDeclaredRemoval", paths: ["stale.txt"] })
  })

  it("refuses to replay evidence naming a path outside the workspace", async () => {
    // Evidence can arrive from a foreign producer through cache sync, and
    // replay DELETES what it names: confinement is the difference between a
    // refusal and a wipe.
    const host = memoryFs({})
    const failure = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        return yield* Effect.flip(boundary.replayOutputs({
          declaredOutputs: { outputs: [{ path: "../escape.txt", digest: null }] },
          diffIdentity: "tampered"
        }))
      }).pipe(Effect.provide(host.layer))
    )
    expect(failure).toMatchObject({ code: "unsupported_boundary" })
    const absolute = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        return yield* Effect.flip(boundary.replayOutputs({
          declaredOutputs: { outputs: [], trees: [{ path: "/", identity: "x" }] },
          diffIdentity: "tampered"
        }))
      }).pipe(Effect.provide(host.layer))
    )
    expect(absolute).toMatchObject({ code: "unsupported_boundary" })
  })

  it("expands root-level patterns and walks a shared include prefix once", async () => {
    // A root-level pattern walks the workspace root itself; two includes with
    // one static prefix walk that subtree once and still match through every
    // include.
    const host = memoryFs({ "a.out": "x", "docs/a.md": "m", "docs/b.txt": "t", "src/skip.js": "s" })
    const evidence = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        const prepared = yield* boundary.prepare({
          readSet: [],
          writeSet: [{ _tag: "Glob", include: ["*.out", "docs/*.md", "docs/*.txt"] }],
          boundaryMode: "hard"
        })
        return yield* boundary.settle(prepared)
      }).pipe(Effect.provide(host.layer))
    )
    const captured = (evidence.declaredOutputs as { outputs: ReadonlyArray<{ path: string }> }).outputs
    expect(captured.map((output) => output.path)).toEqual(["a.out", "docs/a.md", "docs/b.txt"])
  })

  it("expands globs and trees over dotfiles, and replay restores them", async () => {
    // Node's own glob skips dotfiles; the declared-pattern matcher does not.
    // A tree capture that missed `.gitignore` would DELETE it on every
    // cache-hit replay, because replay clears the tree first.
    const host = memoryFs({ "dist/.hidden": "dot", "dist/app.js": "code" })
    const evidence = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        const prepared = yield* boundary.prepare({
          readSet: [],
          writeSet: [{ _tag: "TreeArtifact", path: "dist" }],
          boundaryMode: "hard"
        })
        return yield* boundary.settle(prepared)
      }).pipe(Effect.provide(host.layer))
    )
    const captured = (evidence.declaredOutputs as { outputs: ReadonlyArray<{ path: string }> }).outputs
    expect(captured.map((output) => output.path).sort()).toEqual(["dist/.hidden", "dist/app.js"])

    const consumer = memoryFs({ "dist/stale.js": "old" })
    await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        yield* boundary.replayOutputs(evidence)
      }).pipe(Effect.provide(consumer.layer))
    )
    expect(consumer.files.has("dist/stale.js")).toBe(false)
    expect(decoder.decode(consumer.files.get("dist/.hidden"))).toBe("dot")
    expect(decoder.decode(consumer.files.get("dist/app.js"))).toBe("code")
  })

  it("does not count a declared removal as an undeclared write", async () => {
    const host = memoryFs({ "input.txt": "original", "output.txt": "built" })
    const evidence = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        const prepared = yield* boundary.prepare({
          readSet: [{ path: "input.txt", digest: sha256("original") }],
          writeSet: ["output.txt"],
          removes: ["input.txt"],
          boundaryMode: "hard"
        })
        host.files.delete("input.txt")
        return yield* boundary.settle(prepared)
      }).pipe(Effect.provide(host.layer))
    )
    expect(evidence.deviation).toBeUndefined()
  })

  it("treats mutations covered by tree and glob outputs as declared", async () => {
    const host = memoryFs({ "tree/a.txt": "before", "generated/a.js": "before" })
    const evidence = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        const prepared = yield* boundary.prepare({
          readSet: [
            { path: "tree/a.txt", digest: sha256("before") },
            { path: "generated/a.js", digest: sha256("before") }
          ],
          writeSet: [
            { _tag: "TreeArtifact", path: "tree" },
            { _tag: "Glob", include: ["generated/**/*.js"] }
          ],
          boundaryMode: "hard"
        })
        host.files.set("tree/a.txt", encoder.encode("after"))
        host.files.set("generated/a.js", encoder.encode("after"))
        return yield* boundary.settle(prepared)
      }).pipe(Effect.provide(host.layer))
    )
    expect(evidence.deviation).toBeUndefined()
  })

  it("expands write globs deterministically, applies exclusions, and allows zero matches", async () => {
    const host = memoryFs({
      "dist/a.js": "a",
      "dist/nested/b.js": "b",
      "dist/skip/c.js": "skip",
      "dist/readme.txt": "text"
    })
    const evidence = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        const prepared = yield* boundary.prepare({
          readSet: [],
          writeSet: [{
            _tag: "Glob",
            include: ["dist/**/*.js"],
            exclude: ["dist/skip/**"]
          }],
          boundaryMode: "hard"
        })
        return yield* boundary.settle(prepared)
      }).pipe(Effect.provide(host.layer))
    )
    expect(
      (evidence.declaredOutputs as { outputs: ReadonlyArray<{ path: string }> }).outputs.map((entry) => entry.path)
    )
      .toEqual(["dist/a.js", "dist/nested/b.js"])

    const empty = memoryFs({})
    await expect(runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        return yield* boundary.settle(
          yield* boundary.prepare({
            readSet: [],
            writeSet: [{ _tag: "Glob", include: ["none/**"] }],
            boundaryMode: "hard"
          })
        )
      }).pipe(Effect.provide(empty.layer))
    )).resolves.toBeDefined()
    await expect(runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        return yield* boundary.settle(
          yield* boundary.prepare({
            readSet: [],
            writeSet: [{ _tag: "TreeArtifact", path: "none" }],
            boundaryMode: "hard"
          })
        )
      }).pipe(Effect.provide(empty.layer))
    )).resolves.toBeDefined()
  })

  it("makes a warm replay write-free without recreating parent directories", async () => {
    const producer = memoryFs({ "dist/a.txt": "a", "dist/b.txt": "b" })
    const evidence = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        return yield* boundary.settle(
          yield* boundary.prepare({
            readSet: [],
            writeSet: ["dist/a.txt", "dist/b.txt"],
            boundaryMode: "hard"
          })
        )
      }).pipe(Effect.provide(producer.layer))
    )
    const consumer = memoryFs({})
    const replay = () =>
      runPromise(
        Effect.flatMap(StepBoundary.StepBoundary, (boundary) => boundary.replayOutputs(evidence)).pipe(
          Effect.provide(consumer.layer)
        )
      )

    await replay()
    expect(consumer.writes).toEqual(["dist/a.txt", "dist/b.txt"])
    consumer.writes.length = 0
    consumer.madeDirectories.length = 0

    await replay()
    expect(consumer.writes).toEqual([])
    expect(consumer.madeDirectories).toEqual([])
    expect(decoder.decode(consumer.files.get("dist/a.txt"))).toBe("a")
    expect(decoder.decode(consumer.files.get("dist/b.txt"))).toBe("b")
  })

  it("rewrites only a tampered output", async () => {
    const producer = memoryFs({ "dist/a.txt": "a", "dist/b.txt": "b" })
    const evidence = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        return yield* boundary.settle(
          yield* boundary.prepare({
            readSet: [],
            writeSet: ["dist/a.txt", "dist/b.txt"],
            boundaryMode: "hard"
          })
        )
      }).pipe(Effect.provide(producer.layer))
    )
    const consumer = memoryFs({ "dist/a.txt": "tampered", "dist/b.txt": "b" })

    await runPromise(
      Effect.flatMap(StepBoundary.StepBoundary, (boundary) => boundary.replayOutputs(evidence)).pipe(
        Effect.provide(consumer.layer)
      )
    )

    expect(consumer.writes).toEqual(["dist/a.txt"])
    expect(decoder.decode(consumer.files.get("dist/a.txt"))).toBe("a")
    expect(decoder.decode(consumer.files.get("dist/b.txt"))).toBe("b")
  })

  it("verifies the destination before decoding inline content or reading an artifact", async () => {
    const host = memoryFs({ "inline.txt": "inline", "referenced.txt": "referenced" })
    const boundary = StepBoundary.makeFileSystem(host.fs, ArtifactStore.makeNoop())

    await runPromise(
      boundary.replayOutputs({
        declaredOutputs: {
          outputs: [
            { path: "inline.txt", digest: sha256("inline"), content: "%%%not-base64%%%" },
            { path: "referenced.txt", digest: sha256("referenced") }
          ]
        },
        diffIdentity: "warm-short-circuit"
      })
    )

    // The first row would be corrupt if decoded and the second store refuses
    // every read. Matching destination digests make both unnecessary.
    expect(host.writes).toEqual([])
  })

  it("falls through to ordinary materialization when the destination probe fails", async () => {
    const host = memoryFs({ "output.txt": "stale" })
    host.failedReads.add("output.txt")
    const boundary = StepBoundary.makeFileSystem(host.fs, ArtifactStore.makeNoop())

    await runPromise(
      boundary.replayOutputs({
        declaredOutputs: {
          outputs: [{
            path: "output.txt",
            digest: sha256("recorded"),
            content: Encoding.encodeBase64(encoder.encode("recorded"))
          }]
        },
        diffIdentity: "probe-refused"
      })
    )

    expect(host.writes).toEqual(["output.txt"])
    expect(decoder.decode(host.files.get("output.txt"))).toBe("recorded")
  })

  it("diffs a tree artifact, including dotfiles, and removes only stale empty directories", async () => {
    const producer = memoryFs({
      "tree/.kept": "dotfile",
      "tree/a.txt": "a",
      "tree/nested/b.txt": "b"
    })
    const evidence = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        return yield* boundary.settle(
          yield* boundary.prepare({
            readSet: [],
            writeSet: [{ _tag: "TreeArtifact", path: "tree" }],
            boundaryMode: "hard"
          })
        )
      }).pipe(Effect.provide(producer.layer))
    )
    const outputs = evidence.declaredOutputs as {
      readonly outputs: ReadonlyArray<{ readonly path: string }>
      readonly trees: ReadonlyArray<{ readonly path: string; readonly identity: string }>
    }
    expect(outputs.outputs.map((entry) => entry.path)).toEqual([
      "tree/.kept",
      "tree/a.txt",
      "tree/nested/b.txt"
    ])
    expect(outputs.trees[0]).toMatchObject({ path: "tree" })
    expect(outputs.trees[0]!.identity).toMatch(/^key1_/)

    const consumer = memoryFs({
      "tree/.kept": "dotfile",
      "tree/a.txt": "a",
      "tree/nested/b.txt": "tampered",
      "tree/stale/.secret": "stale"
    })
    await runPromise(
      Effect.flatMap(StepBoundary.StepBoundary, (boundary) => boundary.replayOutputs(evidence)).pipe(
        Effect.provide(consumer.layer)
      )
    )
    expect([...consumer.files.keys()].sort()).toEqual([
      "tree/.kept",
      "tree/a.txt",
      "tree/nested/b.txt"
    ])
    expect(consumer.writes).toEqual(["tree/nested/b.txt"])
    expect(consumer.removals).toEqual(["tree/stale/.secret", "tree/stale"])
    expect(consumer.directories.has("tree/stale")).toBe(false)
    expect(decoder.decode(consumer.files.get("tree/nested/b.txt"))).toBe("b")
  })

  it("fully materializes a recorded tree when its root is missing", async () => {
    const producer = memoryFs({ "tree/a.txt": "a", "tree/nested/b.txt": "b" })
    const evidence = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        return yield* boundary.settle(
          yield* boundary.prepare({
            readSet: [],
            writeSet: [{ _tag: "TreeArtifact", path: "tree" }],
            boundaryMode: "hard"
          })
        )
      }).pipe(Effect.provide(producer.layer))
    )
    const consumer = memoryFs({ "tree/old.txt": "old" })
    await runPromise(consumer.fs.remove("tree", { recursive: true, force: true }))
    consumer.removals.length = 0

    await runPromise(
      Effect.flatMap(StepBoundary.StepBoundary, (boundary) => boundary.replayOutputs(evidence)).pipe(
        Effect.provide(consumer.layer)
      )
    )

    expect(consumer.writes).toEqual(["tree/a.txt", "tree/nested/b.txt"])
    expect([...consumer.files.keys()].sort()).toEqual(["tree/a.txt", "tree/nested/b.txt"])
    expect(consumer.directories.has("tree")).toBe(true)
    expect(consumer.directories.has("tree/nested")).toBe(true)
  })

  it("captures write-set outputs and re-materializes them on a fresh workspace", async () => {
    const producer = memoryFs({ "input.txt": "original" })
    const evidence = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        const prepared = yield* boundary.prepare(declared("original"))
        producer.files.set("output.txt", encoder.encode("produced artifact"))
        return yield* boundary.settle(prepared)
      }).pipe(Effect.provide(producer.layer))
    )
    // `diffIdentity` is a `Key` now, not a bare Sha256 hex: it goes through
    // the repo's one hashing chokepoint, so it carries the `key1_` version
    // marker its derivation is named by.
    expect(evidence.diffIdentity).toMatch(/^key1_[0-9a-f]{64}$/)

    // A different workspace that never ran the step, plus stale garbage at a
    // path the evidence records as absent.
    const replayer = memoryFs({ "stale.txt": "left over" })
    const staleEvidence = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        const prepared = yield* boundary.prepare({
          // A declared read that is also a declared write is exempt from the
          // undeclared-mutation check: mutating it is the declared contract.
          readSet: [{ path: "output.txt", digest: sha256("pre-state") }],
          writeSet: ["output.txt"],
          // The digest-null capture that makes replay delete a path is now
          // reachable only through a DECLARED removal: an undeclared absence
          // is a `MissingDeclaredOutput` defect, because caching it would hand
          // every later replay an eraser.
          removes: ["stale.txt", "gone.txt"],
          boundaryMode: "hard"
        })
        replayer.files.set("output.txt", encoder.encode("produced artifact"))
        replayer.files.delete("stale.txt")
        return yield* boundary.settle(prepared)
      }).pipe(Effect.provide(replayer.layer))
    )
    // "gone.txt" was recorded absent and is already absent on the target:
    // replay leaves it absent without attempting a remove.
    const target = memoryFs({ "stale.txt": "left over" })
    await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        yield* boundary.replayOutputs(staleEvidence)
      }).pipe(Effect.provide(target.layer))
    )
    expect(decoder.decode(target.files.get("output.txt"))).toBe("produced artifact")
    // A recorded-absent output deletes the stale file on replay.
    expect(target.files.has("stale.txt")).toBe(false)
    expect(target.files.has("gone.txt")).toBe(false)
  })

  it("classifies undecodable inline content as corruption, not a host failure (issue #159)", async () => {
    // A tampered inline row that is no longer valid base64 is cache-origin
    // corruption exactly like a digest mismatch: it must raise
    // `BoundaryCorruption` so the caller routes it to the Inconsistency
    // receiver instead of retrying it as a transient host refusal.
    const host = memoryFs({})
    const failure = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        return yield* Effect.flip(
          boundary.replayOutputs({
            declaredOutputs: {
              outputs: [{
                path: "output.txt",
                digest: "aa".repeat(32),
                sizeBytes: 3,
                content: "%%%not-base64%%%"
              }]
            },
            diffIdentity: "corrupt-inline"
          })
        )
      }).pipe(Effect.provide(host.layer))
    )
    expect(failure).toMatchObject({
      _tag: "flows/engine-store/BoundaryCorruption",
      code: "boundary_corruption",
      path: "output.txt",
      recordedDigest: "aa".repeat(32),
      measuredDigest: "invalid_base64"
    })
    expect(host.files.has("output.txt")).toBe(false)
  })

  it("classifies undecodable legacy inline content as corruption too (issue #159)", async () => {
    const host = memoryFs({})
    const failure = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        return yield* Effect.flip(
          boundary.replayOutputs({
            declaredOutputs: { outputs: [{ path: "legacy.txt", content: "%%%not-base64%%%" }] },
            diffIdentity: "corrupt-legacy"
          })
        )
      }).pipe(Effect.provide(host.layer))
    )
    expect(failure).toMatchObject({
      _tag: "flows/engine-store/BoundaryCorruption",
      code: "boundary_corruption",
      path: "legacy.txt",
      recordedDigest: "legacy_inline",
      measuredDigest: "invalid_base64"
    })
  })

  it("refuses to replay evidence recorded without materializable outputs", async () => {
    const host = memoryFs({})
    const failure = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        return yield* Effect.flip(
          boundary.replayOutputs({ declaredOutputs: { paths: ["output.txt"] }, diffIdentity: "foreign" })
        )
      }).pipe(Effect.provide(host.layer))
    )
    expect(failure).toMatchObject({ code: "unsupported_boundary" })
  })
})

describe("StepBoundary.layer host failures", () => {
  it("maps a filesystem failure to UnsupportedBoundary", async () => {
    const fs = FileSystem.makeNoop({
      exists: (() => Effect.succeed(true)) as never
      // readFile keeps the noop default and fails: the host cannot measure.
    })
    const failure = await runPromise(
      Effect.gen(function*() {
        const boundary = yield* StepBoundary.StepBoundary
        return yield* Effect.flip(
          boundary.prepare({
            readSet: [{ path: "input.txt", digest: "d" }],
            writeSet: [],
            boundaryMode: "hard"
          })
        )
      }).pipe(
        Effect.provide(StepBoundary.layer.pipe(Layer.provide(hostLayer(fs))))
      )
    )
    expect(failure).toMatchObject({ code: "unsupported_boundary" })
  })
})

describe("StepBoundary stays importable from a browser bundle (issue #114)", () => {
  it("has no module-scope node: imports", async () => {
    // The module exports the contract schemas, the service tag, and
    // `layerTest` — all of which a browser composition must import — so a
    // module-scope node: dependency would drag Node builtins into every
    // bundle. Base64 goes through the platform-neutral `effect/Encoding`.
    const fs = await import("node:fs/promises")
    const url = await import("node:url")
    const source = await fs.readFile(
      url.fileURLToPath(new URL("../src/StepBoundary.ts", import.meta.url)),
      "utf8"
    )
    expect(source).not.toMatch(/from "node:/)
  })
})
