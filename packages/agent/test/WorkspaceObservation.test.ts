/**
 * The measurement the loop's mutation accounting is built on.
 *
 * These cases fix what a measurement covers and what it deliberately does not:
 * a shell write moves it, a test run that only fills caches does not, and a
 * path that vanishes mid-walk is left out rather than failing the frame. The
 * controller only ever compares two measurements for equality, so the whole
 * contract is "the digest moves exactly when the tree the run is judged on
 * moves".
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as EngineLike from "@smthrs/harness/EngineLike"
import { Effect, FileSystem, Layer, Option } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as WorkspaceObservation from "../src/WorkspaceObservation.ts"

const workspace = (): string => mkdtempSync(join(tmpdir(), "flows-observation-"))

const write = (root: string, path: string, content: string): void => {
  const full = join(root, path)
  mkdirSync(join(full, ".."), { recursive: true })
  writeFileSync(full, content)
}

const measured = (
  root: string,
  options: WorkspaceObservation.Options = {}
): Promise<EngineLike.Observation> =>
  Effect.runPromise(
    Effect.flatMap(FileSystem.FileSystem, (fs) => WorkspaceObservation.observe(fs, root, options)).pipe(
      Effect.provide(NodeFileSystem.layer)
    )
  )

describe("WorkspaceObservation", () => {
  it("moves when a tracked file is rewritten by anything at all", async () => {
    const root = workspace()
    write(root, "src/python.py", "the fix")
    const before = await measured(root)

    // Exactly what SWE-bench wave 5's frame 9 did: a shell redirect put the
    // base revision back over the file, no flow declared a write, and every
    // control in the harness saw an idle frame.
    write(root, "src/python.py", "the base revision, which is longer")
    const after = await measured(root)

    expect(before.paths).toBe(1)
    expect(after.digest).not.toBe(before.digest)
    rmSync(root, { recursive: true, force: true })
  })

  it("reports the same measurement for a tree nothing touched", async () => {
    const root = workspace()
    write(root, "a.py", "one")
    write(root, "nested/b.py", "two")

    expect((await measured(root)).digest).toBe((await measured(root)).digest)
    expect((await measured(root)).paths).toBe(2)
    rmSync(root, { recursive: true, force: true })
  })

  it("ignores the caches and compiled output a test run leaves behind", async () => {
    const root = workspace()
    write(root, "a.py", "one")
    const before = await measured(root)

    // A `pytest` invocation writes bytecode caches beside the sources and an
    // in-place build drops shared objects next to them. Counting either would
    // report every probe as an edit, which satisfies the read-only cap forever
    // — the same blindness inverted.
    write(root, "__pycache__/a.cpython-39.pyc", "bytecode")
    write(root, ".pytest_cache/v/cache/lastfailed", "{}")
    write(root, "a.cpython-39-x86_64-linux-gnu.so", "compiled")
    write(root, ".git/index", "git state")

    expect((await measured(root)).digest).toBe(before.digest)
    rmSync(root, { recursive: true, force: true })
  })

  it("counts a file under a directory the caller did not exclude", async () => {
    const root = workspace()
    write(root, "build/artifact.txt", "kept")

    // The pruning is a declared policy, not a guess about what matters: a host
    // whose derived artifacts differ names its own list, and everything else
    // is measured.
    expect((await measured(root, { prune: [], ignoreSuffixes: [] })).paths).toBe(1)
    expect((await measured(root, { prune: ["build"] })).paths).toBe(0)
    rmSync(root, { recursive: true, force: true })
  })

  it("stops at the path bound and still reports a usable measurement", async () => {
    const root = workspace()
    write(root, "a.py", "one")
    write(root, "b.py", "two")
    write(root, "c.py", "three")

    const bounded = await measured(root, { maxPaths: 2 })
    expect(bounded.paths).toBe(2)
    // The walk is ordered, so the covered prefix is the same between frames and
    // a change inside it still moves the digest.
    write(root, "a.py", "one, edited")
    expect((await measured(root, { maxPaths: 2 })).digest).not.toBe(bounded.digest)
    rmSync(root, { recursive: true, force: true })
  })

  it("stops descending once the bound is reached", async () => {
    const root = workspace()
    write(root, "a/one.py", "one")
    write(root, "b/two.py", "two")

    expect((await measured(root, { maxPaths: 1 })).paths).toBe(1)
    rmSync(root, { recursive: true, force: true })
  })

  it("measures an empty root as an empty tree rather than failing", async () => {
    const root = workspace()
    const empty = await measured(`${root}/`)

    expect(empty.paths).toBe(0)
    // A root that is not there at all is the same answer: the walk contributes
    // nothing and the next measurement reports whatever appears.
    expect((await measured(join(root, "absent"))).digest).toBe(empty.digest)
    rmSync(root, { recursive: true, force: true })
  })

  it("leaves out a path that disappeared between listing and measuring", async () => {
    const root = workspace()
    write(root, "kept.py", "one")
    write(root, "vanishing.py", "two")

    // A run's own background process can remove a file mid-walk. The tree
    // moved; that is a fact for the next measurement to report, not a reason
    // to fail the frame.
    const fs = await Effect.runPromise(
      Effect.map(FileSystem.FileSystem, (found): FileSystem.FileSystem => ({
        ...found,
        stat: (path) =>
          `${path}`.endsWith("vanishing.py")
            ? found.stat(join(root, "gone.py"))
            : found.stat(path)
      })).pipe(Effect.provide(NodeFileSystem.layer))
    )
    const observation = await Effect.runPromise(WorkspaceObservation.observe(fs, root))

    expect(observation.paths).toBe(1)
    rmSync(root, { recursive: true, force: true })
  })

  it("keeps a file whose host reports no modification time, and skips what is neither file nor directory", async () => {
    const root = workspace()
    write(root, "a.py", "one")
    write(root, "socket", "not really")

    // Two host answers a real filesystem can give and a temporary directory
    // cannot be made to give: an entry that is neither a file nor a directory,
    // and a file whose modification time is unavailable. The first contributes
    // nothing; the second still contributes its path and size, so a rewrite
    // that changes the length is still seen.
    const fs = await Effect.runPromise(
      Effect.map(FileSystem.FileSystem, (found): FileSystem.FileSystem => ({
        ...found,
        stat: (path) =>
          Effect.map(found.stat(path), (info) =>
            `${path}`.endsWith("socket")
              ? { ...info, type: "SymbolicLink" as const }
              : { ...info, mtime: Option.none() })
      })).pipe(Effect.provide(NodeFileSystem.layer))
    )

    const observation = await Effect.runPromise(WorkspaceObservation.observe(fs, root))
    expect(observation.paths).toBe(1)
    rmSync(root, { recursive: true, force: true })
  })

  it("counts only files, never the directories holding them", async () => {
    const root = workspace()
    write(root, "one/two/three.py", "leaf")

    expect((await measured(root)).paths).toBe(1)
    rmSync(root, { recursive: true, force: true })
  })

  it("provides an observer over the host filesystem, and a failing one for a host with none", async () => {
    const root = workspace()
    write(root, "a.py", "one")

    const observed = await Effect.runPromise(
      Effect.flatMap(WorkspaceObservation.Observer, (observer) => observer.observe).pipe(
        Effect.provide(WorkspaceObservation.layer(root).pipe(Layer.provide(NodeFileSystem.layer)))
      )
    )
    expect(observed.paths).toBe(1)

    const refused = await Effect.runPromise(
      Effect.flatMap(WorkspaceObservation.Observer, (observer) => observer.observe).pipe(
        Effect.provide(WorkspaceObservation.layerNoop),
        Effect.result
      )
    )
    expect(refused._tag).toBe("Failure")
    rmSync(root, { recursive: true, force: true })
  })

  it("builds an observer from a filesystem the caller already holds", async () => {
    const root = workspace()
    write(root, "a.py", "one")

    const observation = await Effect.runPromise(
      Effect.flatMap(
        FileSystem.FileSystem,
        (fs) => WorkspaceObservation.make(fs, root).observe
      ).pipe(Effect.provide(NodeFileSystem.layer))
    )

    expect(observation.paths).toBe(1)
    rmSync(root, { recursive: true, force: true })
  })
})
