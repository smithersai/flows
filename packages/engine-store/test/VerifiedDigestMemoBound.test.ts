/**
 * Issue #155: the issue-#144 verified-digest memo was a plain `Set<string>`
 * accumulating one entry per distinct blob digest for the store's whole
 * lifetime — no cap, no eviction on the healthy path — so a long-lived
 * server host spilling outputs across hundreds of thousands of steps grew
 * it monotonically. The memo's FINAL shape is a bounded LRU: a fixed
 * capacity of 4096 digests, hits refresh recency, inserting past capacity
 * evicts the least-recently-used digest, and eviction costs only the #132
 * re-verification on that digest's next capture — never correctness.
 */
import type { FileBoundary } from "@smthrs/engine/FileBoundary"
import { FileSystem } from "@smthrs/kernel"
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as StepBoundary from "../src/StepBoundary.ts"
import { runPromise, sha256 } from "./Sha256.ts"

const encoder = new TextEncoder()

/** The fixed capacity documented as final in `StepBoundary.makeFileSystem`. */
const capacity = 4096

/** An in-memory host filesystem with per-path read/write instrumentation. */
const memoFs = () => {
  const files = new Map<string, Uint8Array>()
  const reads: Array<string> = []
  const writes: Array<string> = []
  const fs = FileSystem.makeNoop({
    exists: ((path: string) => Effect.succeed(files.has(path))) as never,
    readFile: ((path: string) =>
      Effect.suspend(() => {
        reads.push(path)
        return files.has(path)
          ? Effect.succeed(files.get(path)!)
          : Effect.fail(new Error(`ENOENT: ${path}`))
      })) as never,
    makeDirectory: (() => Effect.void) as never,
    readDirectory: (() => Effect.fail(new Error("ENOENT: no objects directory"))) as never,
    writeFile: ((path: string, bytes: Uint8Array) =>
      Effect.sync(() => {
        writes.push(path)
        files.set(path, bytes)
      })) as never,
    rename: ((from: string, to: string) =>
      Effect.suspend(() => {
        const bytes = files.get(from)
        if (bytes === undefined) return Effect.fail(new Error(`ENOENT: ${from}`))
        files.set(to, bytes)
        files.delete(from)
        return Effect.void
      })) as never,
    remove: ((path: string) =>
      Effect.sync(() => {
        files.delete(path)
      })) as never
  })
  return { files, reads, writes, fs }
}

const descriptor: FileBoundary = {
  readSet: [],
  writeSet: ["artifact.bin"],
  boundaryMode: "hard"
}

const blobPathOf = (content: string) => `.flows/objects/${sha256(encoder.encode(content))}`

/** Spills `content` (always over the 4-byte inline bound) through `boundary`. */
const spill = (boundary: StepBoundary.Service, host: ReturnType<typeof memoFs>, content: string) =>
  Effect.gen(function*() {
    const prepared = yield* boundary.prepare(descriptor)
    host.files.set("artifact.bin", encoder.encode(content))
    yield* boundary.settle(prepared)
  })

// These finite-capacity loops terminate by count; elapsed time depends only on
// machine load, which the package-wide `testTimeout` budgets for.
describe("the verified-digest memo is a bounded LRU (issue #155)", () => {
  it("evicts the least-recently-used digest past the fixed capacity, re-verifying only that one", async () => {
    const host = memoFs()
    const boundary = StepBoundary.makeFileSystem(host.fs, { maxInlineBytes: 4 })
    const first = "memo-bound-first-content"
    await runPromise(
      Effect.gen(function*() {
        yield* spill(boundary, host, first)
        // The store published `first` itself, so a repeat capture needs no
        // verification read of its blob.
        yield* spill(boundary, host, first)
        // Fill the memo with `capacity` further distinct digests: `first`
        // becomes the least-recently-used entry and is evicted exactly once
        // the size passes the cap.
        for (let index = 0; index < capacity; index++) {
          yield* spill(boundary, host, `memo-bound-filler-${index}`)
        }
      })
    )
    expect(host.reads.filter((path) => path === blobPathOf(first))).toHaveLength(0)
    // The evicted digest's next capture re-verifies the existing blob — one
    // read+hash — and, on the verified match, skips the rewrite.
    const temps = host.writes.filter((path) => path.startsWith(`${blobPathOf(first)}.tmp-`)).length
    await runPromise(spill(boundary, host, first))
    expect(host.reads.filter((path) => path === blobPathOf(first))).toHaveLength(1)
    expect(host.writes.filter((path) => path.startsWith(`${blobPathOf(first)}.tmp-`))).toHaveLength(temps)
  })

  it("refreshes recency on a memo hit, so hot digests survive and the stale one is evicted", async () => {
    const host = memoFs()
    const boundary = StepBoundary.makeFileSystem(host.fs, { maxInlineBytes: 4 })
    const hot = "memo-lru-hot-content"
    const cold = "memo-lru-cold-content"
    await runPromise(
      Effect.gen(function*() {
        yield* spill(boundary, host, hot)
        yield* spill(boundary, host, cold)
        // A memo hit must move `hot` to the newest end — a FIFO would leave
        // it the oldest entry and evict it below.
        yield* spill(boundary, host, hot)
        // `hot` + `cold` + (capacity - 1) fillers exceed the cap by one:
        // exactly one eviction, and LRU order says it is `cold`.
        for (let index = 0; index < capacity - 1; index++) {
          yield* spill(boundary, host, `memo-lru-filler-${index}`)
        }
        yield* spill(boundary, host, hot)
        yield* spill(boundary, host, cold)
      })
    )
    // `hot` never needed a verification read; `cold` was evicted and re-paid
    // exactly one.
    expect(host.reads.filter((path) => path === blobPathOf(hot))).toHaveLength(0)
    expect(host.reads.filter((path) => path === blobPathOf(cold))).toHaveLength(1)
  })
})
