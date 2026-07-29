import { Layer, Path, Random } from "effect"
import type { FileSystem } from "effect"
import { TestClock } from "effect/testing"
import * as BrowserFileSystem from "../browser/BrowserFileSystem.ts"
import { layerJjUnsupported, layerPtyUnsupported } from "../browser/BrowserHost.ts"
import * as JustBashShell from "../browser/JustBashShell.ts"
import * as HttpTransport from "../HttpTransport.ts"
import type { Jj } from "../Jj.ts"
import type { Pty } from "../Pty.ts"
import type { Shell } from "../Shell.ts"

/** POSIX-normalize so `/a/b`, `/a/b/`, and `/a/./b` are one key in the store. */
const normalize = (path: string): string => {
  const parts: Array<string> = []
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  return `/${parts.join("/")}`
}

const enoent = (path: string): Error => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" })

interface Entry {
  readonly type: "file" | "directory"
  readonly data: Uint8Array
}

/**
 * A Map-backed filesystem shaped like ZenFS, so the test bundle reuses the very
 * same `BrowserFileSystem` adapter the browser runs. A separate "test
 * FileSystem" would be a second implementation to keep honest; this way a bug in
 * the adapter shows up in tests.
 */
export const makeMemoryFs = (
  initial?: Readonly<Record<string, string>>
): BrowserFileSystem.ZenFsPromisesLike => {
  const entries = new Map<string, Entry>([["/", { type: "directory", data: new Uint8Array() }]])
  const encoder = new TextEncoder()

  const mkdirp = (path: string): void => {
    const parts = normalize(path).split("/").filter((p) => p !== "")
    let current = ""
    for (const part of parts) {
      current = `${current}/${part}`
      if (!entries.has(current)) entries.set(current, { type: "directory", data: new Uint8Array() })
    }
  }

  const put = (path: string, data: Uint8Array): void => {
    const key = normalize(path)
    mkdirp(key.replace(/\/[^/]*$/, "") || "/")
    entries.set(key, { type: "file", data })
  }

  for (const [path, contents] of Object.entries(initial ?? {})) put(path, encoder.encode(contents))

  const get = (path: string): Entry => {
    const entry = entries.get(normalize(path))
    if (entry === undefined) throw enoent(path)
    return entry
  }

  return {
    open: async (path) => {
      const entry = get(path)
      if (entry.type !== "file") throw enoent(path)
      return {
        read: async (buffer, offset, length, position) => {
          const bytesRead = Math.min(length, Math.max(0, entry.data.length - position))
          if (bytesRead > 0) {
            buffer.set(entry.data.subarray(position, position + bytesRead), offset)
          }
          return { bytesRead }
        },
        close: async () => {}
      }
    },
    readFile: async (path) => {
      const entry = get(path)
      if (entry.type !== "file") throw enoent(path)
      return entry.data
    },
    writeFile: async (path, data) => put(path, data),
    mkdir: async (path, options) => {
      if (options?.recursive === true) mkdirp(path)
      else entries.set(normalize(path), { type: "directory", data: new Uint8Array() })
    },
    readdir: async (path) => {
      const dir = normalize(path)
      if (get(dir).type !== "directory") throw enoent(path)
      const prefix = dir === "/" ? "/" : `${dir}/`
      const names = new Set<string>()
      for (const key of entries.keys()) {
        if (key === dir || !key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        const head = rest.split("/")[0]
        if (head !== undefined && head !== "") names.add(head)
      }
      return [...names].sort()
    },
    stat: async (path) => {
      const entry = get(path)
      return {
        size: entry.data.byteLength,
        mode: entry.type === "directory" ? 0o040755 : 0o100644,
        /** Fixed epoch: file metadata must never make a test flaky. */
        mtimeMs: 0,
        isFile: () => entry.type === "file",
        isDirectory: () => entry.type === "directory",
        isSymbolicLink: () => false
      }
    },
    rm: async (path, options) => {
      const key = normalize(path)
      if (!entries.has(key)) {
        if (options?.force === true) return
        throw enoent(path)
      }
      entries.delete(key)
      if (options?.recursive === true) {
        for (const other of [...entries.keys()]) {
          if (other.startsWith(`${key}/`)) entries.delete(other)
        }
      }
    }
  }
}

/**
 * A scripted stand-in for just-bash: commands are looked up in a table, and an
 * unlisted command fails the way a real shell reports a missing binary. Tests
 * that need shell output declare it; tests that do not, cannot accidentally
 * depend on a host tool being installed.
 */
export const makeStubBash = (
  responses?: Readonly<Record<string, { stdout?: string; stderr?: string; exitCode?: number }>>
): JustBashShell.JustBashLike => ({
  run: async (command) => {
    const scripted = responses?.[command]
    if (scripted === undefined) {
      return { stdout: "", stderr: `command not found: ${command}\n`, exitCode: 127 }
    }
    return {
      stdout: scripted.stdout ?? "",
      stderr: scripted.stderr ?? "",
      exitCode: scripted.exitCode ?? 0
    }
  },
  getCwd: () => "/"
})

/**
 * Seeded PRNG (mulberry32) as a `Random` layer.
 *
 * `Random.withSeed` exists but is an `Effect` combinator, and a Host bundle has
 * to be a `Layer` — so we provide the two-method `Random` reference directly.
 */
export const layerSeededRandom = (seed = 42): Layer.Layer<never> =>
  Layer.succeed(Random.Random)(
    (() => {
      let state = seed >>> 0
      const nextDoubleUnsafe = (): number => {
        state = (state + 0x6d2b79f5) >>> 0
        let t = state
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
      return {
        nextDoubleUnsafe,
        nextIntUnsafe: () => Math.floor(nextDoubleUnsafe() * Number.MAX_SAFE_INTEGER)
      }
    })()
  )

/**
 * The deterministic Host bundle.
 *
 * Every source of nondeterminism is pinned: an in-memory filesystem, a scripted
 * shell, `TestClock` (time only moves when a test calls `TestClock.adjust`), and
 * a seeded PRNG. `Pty` and `Jj` reuse the browser's ticket-failing layers so a
 * test that reaches for them fails loudly instead of touching the real machine.
 */
export const layer = (options?: {
  readonly files?: Readonly<Record<string, string>>
  readonly commands?: Readonly<Record<string, { stdout?: string; stderr?: string; exitCode?: number }>>
  readonly seed?: number
}): Layer.Layer<FileSystem.FileSystem | Path.Path | Shell | Pty | Jj | HttpTransport.HttpTransport> =>
  Layer.mergeAll(
    BrowserFileSystem.layer(makeMemoryFs(options?.files)),
    Path.layer,
    JustBashShell.layer(makeStubBash(options?.commands)),
    HttpTransport.layerNoop(),
    layerPtyUnsupported,
    layerJjUnsupported,
    TestClock.layer(),
    layerSeededRandom(options?.seed)
  )

/** The zero-config bundle: empty filesystem, no scripted commands, seed 42. */
export const TestHost: Layer.Layer<FileSystem.FileSystem | Path.Path | Shell | Pty | Jj | HttpTransport.HttpTransport> =
  layer()
