/**
 * `BrowserJj` over the REAL `flows_jj.wasm` artifact — jj-lib compiled to
 * wasm32-wasip1 — running against a temp-directory-rooted `SyncFsLike`,
 * mirroring the `NodeJj` real-binary scenarios: snapshot/diff/status
 * roundtrip, restore, workspace lanes, and `invalid_ref` classification, plus
 * the browser-specific reload-survival property (a second instantiation over
 * the same tree sees the first's snapshots).
 *
 * The artifact is committed at `packages/jj/wasm/flows_jj.wasm` and built by
 * `npm run build:wasm -w @smthrs/jj-next` (delegating to
 * `crates/flows-jj/build-wasm.mjs`). When it is absent the suite skips —
 * loudly, so a missing artifact is never mistaken for passing coverage.
 */
import * as Effect from "effect/Effect"
import * as fsModule from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as BrowserJj from "../src/browser/BrowserJj.ts"
import { Jj } from "../src/Jj.ts"
import { rootedSyncFs } from "./RootedSyncFs.ts"

const wasmPath = fileURLToPath(new URL("../wasm/flows_jj.wasm", import.meta.url))
const wasmBytes: Uint8Array | undefined = fsModule.existsSync(wasmPath)
  ? new Uint8Array(fsModule.readFileSync(wasmPath))
  : undefined

if (wasmBytes === undefined) {
  // eslint-disable-next-line no-console
  console.warn(
    "[BrowserJjContract] packages/jj/wasm/flows_jj.wasm is not built — the real-artifact "
      + "contract suite is SKIPPED. Build it with `npm run build:wasm -w @smthrs/jj-next` "
      + "(requires the rust wasm32-wasip1 toolchain and crates/flows-jj)."
  )
}

describe.skipIf(wasmBytes === undefined)("BrowserJj over flows_jj.wasm", () => {
  let host = ""
  let jj: Jj
  const timeout = 60_000

  const layer = () =>
    BrowserJj.layer({
      wasm: wasmBytes!,
      fs: rootedSyncFs(host),
      root: "/repo",
      onStderr: (text) => {
        // eslint-disable-next-line no-console
        console.error(`[flows_jj.wasm stderr] ${text}`)
      }
    })

  const write = (path: string, content: string) => fsModule.writeFileSync(join(host, "repo", path), content)
  const read = (path: string) => fsModule.readFileSync(join(host, "repo", path), "utf8")

  beforeAll(async () => {
    host = fsModule.mkdtempSync(join(tmpdir(), "flows-browser-jj-"))
    fsModule.mkdirSync(join(host, "repo"))
    jj = await Effect.runPromise(Effect.provide(Jj, layer()))
  })

  afterAll(() => {
    fsModule.rmSync(host, { recursive: true, force: true })
  })

  it("snapshots the working copy and diffs between snapshots", { timeout }, async () => {
    write("note.txt", "first\n")
    const { changeId: first } = await Effect.runPromise(jj.snapshot("first commit"))
    expect(first).toMatch(/^[a-z0-9]+$/)

    write("note.txt", "second\n")
    const { changeId: second } = await Effect.runPromise(jj.snapshot("second commit"))
    expect(second).not.toBe(first)

    const diff = await Effect.runPromise(jj.diff(first, second))
    expect(diff).toContain("diff --git")
    expect(diff).toContain("note.txt")
    expect(diff).toContain("+second")
    expect(diff).toContain("-first")

    const status = await Effect.runPromise(jj.status())
    expect(status.length).toBeGreaterThan(0)
  })

  it("snapshots without a message when none is supplied", { timeout }, async () => {
    write("unnamed.txt", "x\n")
    const { changeId } = await Effect.runPromise(jj.snapshot())
    expect(changeId).toMatch(/^[a-z0-9]+$/)
  })

  it("restores working-copy files from a snapshot", { timeout }, async () => {
    write("keep.txt", "keep\n")
    const { changeId } = await Effect.runPromise(jj.snapshot("before mutation"))
    write("keep.txt", "mutated\n")
    await Effect.runPromise(jj.restore(changeId))
    expect(read("keep.txt")).toBe("keep\n")
  })

  it("adds and forgets a named workspace lane", { timeout }, async () => {
    await Effect.runPromise(jj.workspaceAdd("lane", "/lane1"))
    expect(fsModule.existsSync(join(host, "lane1"))).toBe(true)
    await Effect.runPromise(jj.workspaceForget("lane"))
  })

  it("classifies an unknown revision as invalid_ref", { timeout }, async () => {
    const error = await Effect.runPromise(Effect.flip(jj.restore("nosuchchangeid")))
    expect(error.code).toBe("invalid_ref")
    // Exactly one method prefix: the bridge prefixes, the crate must not —
    // "jj restore: jj restore: ..." was a real regression.
    expect(error.message).toMatch(/^jj restore: /)
    expect(error.message).not.toContain("jj restore: jj restore:")

    const diffError = await Effect.runPromise(Effect.flip(jj.diff("zzznotachange", "alsonotachange")))
    expect(diffError.code).toBe("invalid_ref")
  })

  it("survives a reload: a fresh instance over the same tree sees prior snapshots", { timeout }, async () => {
    write("durable.txt", "persisted\n")
    const { changeId } = await Effect.runPromise(jj.snapshot("durable state"))

    // a second, independent instantiation — the browser-refresh case
    const reloaded = await Effect.runPromise(Effect.provide(Jj, layer()))
    const status = await Effect.runPromise(reloaded.status())
    expect(status.length).toBeGreaterThan(0)

    write("durable.txt", "scribbled\n")
    await Effect.runPromise(reloaded.restore(changeId))
    expect(read("durable.txt")).toBe("persisted\n")
  })
})
