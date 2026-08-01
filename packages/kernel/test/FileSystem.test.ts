import { Effect, FileSystem as EffectFileSystem, Option, Path as EffectPath, type PlatformError, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Capability from "../src/Capability.ts"
import * as FileSystem from "../src/FileSystem.ts"
import { GrantStore } from "../src/GrantStore.ts"
import { permissionDenied } from "../src/Permission.ts"
import * as Workspace from "../src/Workspace.ts"

const itEffect = (name: string, effect: () => Effect.Effect<void, unknown, never>) =>
  it(name, () => Effect.runPromise(effect()))

const scriptedStore = (allowed: ReadonlySet<string>, checks: Array<Capability.Capability>) =>
  GrantStore.of({
    check: (capability) => {
      checks.push(capability)
      return allowed.has(`${capability.action}:${capability.resource}`)
        ? Effect.void
        : Effect.fail(permissionDenied(capability, "denied by test"))
    },
    reply: () => Effect.die("not used by filesystem decorator tests"),
    list: Effect.succeed([]),
    grantEnvelope: () => Effect.void
  })

const hostFileSystem = (overrides: Partial<EffectFileSystem.FileSystem>) =>
  EffectFileSystem.makeNoop({
    realPath: (path) => Effect.succeed(path),
    ...overrides
  })

const provide = (
  effect: Effect.Effect<void, unknown, FileSystem.FileSystem>,
  host: EffectFileSystem.FileSystem,
  grants: ReturnType<typeof scriptedStore>
) =>
  effect.pipe(
    Effect.provide(FileSystem.layer),
    Effect.provideService(EffectFileSystem.FileSystem, host),
    Effect.provide(EffectPath.layer),
    Effect.provide(Workspace.layer("/workspace")),
    Effect.provideService(GrantStore, grants)
  )

describe("FileSystem", () => {
  itEffect("classifies reads and mutations and normalizes workspace-relative paths", () => {
    const checks: Array<Capability.Capability> = []
    const paths: Array<string> = []
    const host = hostFileSystem({
      stat: (path) =>
        Effect.sync(() => {
          paths.push(path)
          return {} as EffectFileSystem.File.Info
        }),
      writeFile: (path) =>
        Effect.sync(() => {
          paths.push(path)
        }),
      makeDirectory: (path) =>
        Effect.sync(() => {
          paths.push(path)
        })
    })
    const allowed = new Set([
      "fs:read:/workspace/src/file.ts",
      "fs:write:/workspace/out/file.ts",
      "fs:write:/workspace/out"
    ])

    return provide(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        yield* fileSystem.stat("src/dir/../file.ts")
        yield* fileSystem.writeFile("out/file.ts", new Uint8Array())
        yield* fileSystem.makeDirectory("out")
        expect(checks).toEqual([
          { action: "fs:read", resource: "/workspace/src/file.ts" },
          { action: "fs:write", resource: "/workspace/out/file.ts" },
          { action: "fs:write", resource: "/workspace/out" }
        ])
        expect(paths).toEqual([
          "/workspace/src/file.ts",
          "/workspace/src/file.ts",
          "/workspace/out/file.ts",
          "/workspace/out/file.ts",
          "/workspace/out",
          "/workspace/out"
        ])
      }),
      host,
      scriptedStore(allowed, checks)
    )
  })

  itEffect("checks both source and target before copy and rename", () => {
    const checks: Array<Capability.Capability> = []
    const calls: Array<string> = []
    const host = hostFileSystem({
      copy: (from, to) =>
        Effect.sync(() => {
          calls.push(`copy:${from}:${to}`)
        }),
      rename: (from, to) =>
        Effect.sync(() => {
          calls.push(`rename:${from}:${to}`)
        })
    })
    const allowed = new Set([
      "fs:read:/workspace/from",
      "fs:write:/workspace/to",
      "fs:write:/workspace/old",
      "fs:write:/workspace/new"
    ])

    return provide(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        yield* fileSystem.copy("from", "to")
        yield* fileSystem.rename("old", "new")
        expect(checks).toEqual([
          { action: "fs:read", resource: "/workspace/from" },
          { action: "fs:write", resource: "/workspace/to" },
          { action: "fs:write", resource: "/workspace/old" },
          { action: "fs:write", resource: "/workspace/new" }
        ])
        expect(calls).toEqual(["copy:/workspace/from:/workspace/to", "rename:/workspace/old:/workspace/new"])
      }),
      host,
      scriptedStore(allowed, checks)
    )
  })

  itEffect("preserves relative symlink targets and the Effect filesystem runtime marker", () => {
    const checks: Array<Capability.Capability> = []
    const calls: Array<readonly [string, string]> = []
    const host = hostFileSystem({
      symlink: (target, path) =>
        Effect.sync(() => {
          calls.push([target, path])
        })
    })

    return provide(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        expect(fileSystem["~effect/platform/FileSystem"]).toBe("~effect/platform/FileSystem")
        yield* fileSystem.symlink("../target", "links/item")
        expect(checks).toEqual([
          { action: "fs:write", resource: "/workspace/links/item" }
        ])
        expect(calls).toEqual([["../target", "/workspace/links/item"]])
      }),
      host,
      scriptedStore(new Set(["fs:write:/workspace/links/item"]), checks)
    )
  })

  itEffect("normalizes glob patterns relative to their explicit root", () => {
    const checks: Array<Capability.Capability> = []
    const calls: Array<{ readonly pattern: string; readonly root?: string | undefined }> = []
    const host = hostFileSystem({
      glob: (pattern, options) =>
        Effect.sync(() => {
          calls.push({ pattern, root: options?.root })
          return []
        })
    })

    return provide(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        yield* fileSystem.glob("**/*.ts", { root: "src" })
        expect(checks).toEqual([{ action: "fs:read", resource: "/workspace/src/**/*.ts" }])
        expect(calls).toEqual([{ pattern: "/workspace/src/**/*.ts", root: "/workspace/src" }])
      }),
      host,
      scriptedStore(new Set(["fs:read:/workspace/src/**/*.ts"]), checks)
    )
  })

  itEffect("short-circuits a denied request before its delegate", () => {
    const checks: Array<Capability.Capability> = []
    let called = false
    const host = hostFileSystem({
      writeFile: () =>
        Effect.sync(() => {
          called = true
        })
    })

    return provide(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        expect(yield* Effect.flip(fileSystem.writeFile("blocked", new Uint8Array()))).toMatchObject({
          code: "permission_denied",
          capability: { action: "fs:write", resource: "/workspace/blocked" },
          reason: "denied by test"
        })
        expect(called).toBe(false)
        expect(checks).toEqual([{ action: "fs:write", resource: "/workspace/blocked" }])
      }),
      host,
      scriptedStore(new Set(), checks)
    )
  })

  itEffect("checks both handle acquisition and later handle reads", () => {
    const checks: Array<Capability.Capability> = []
    let reads = 0
    const handle: EffectFileSystem.File = {
      [EffectFileSystem.FileTypeId]: EffectFileSystem.FileTypeId,
      fd: EffectFileSystem.FileDescriptor(1),
      stat: Effect.die("not used"),
      seek: () => Effect.void,
      sync: Effect.void,
      read: () => Effect.sync(() => EffectFileSystem.Size(++reads)),
      readAlloc: () => Effect.succeed(Option.none()),
      truncate: () => Effect.void,
      write: () => Effect.succeed(EffectFileSystem.Size(0)),
      writeAll: () => Effect.void
    }
    const host = hostFileSystem({ open: () => Effect.succeed(handle) })

    return provide(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const file = yield* fileSystem.open("input", { flag: "r" })
        yield* file.read(new Uint8Array())
        expect(reads).toBe(1)
        expect(checks).toEqual([
          { action: "fs:read", resource: "/workspace/input" },
          { action: "fs:read", resource: "/workspace/input" }
        ])
      }).pipe(Effect.scoped),
      host,
      scriptedStore(new Set(["fs:read:/workspace/input"]), checks)
    )
  })

  itEffect("checks a stream lazily, before the host stream is acquired", () => {
    const checks: Array<Capability.Capability> = []
    let acquired = false
    const host = hostFileSystem({
      stream: () =>
        Stream.succeed(new Uint8Array([1])).pipe(Stream.tap(() =>
          Effect.sync(() => {
            acquired = true
          })
        ))
    })

    return provide(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        const stream = fileSystem.stream("lazy")
        expect(checks).toEqual([])
        expect(acquired).toBe(false)
        yield* Stream.runDrain(stream)
        expect(checks).toEqual([{ action: "fs:read", resource: "/workspace/lazy" }])
        expect(acquired).toBe(true)
      }),
      host,
      scriptedStore(new Set(["fs:read:/workspace/lazy"]), checks)
    )
  })

  itEffect("uses the canonical target when an inside-workspace symlink escapes", () => {
    const checks: Array<Capability.Capability> = []
    let invoked = false
    const host = hostFileSystem({
      realPath: (path) => Effect.succeed(path === "/workspace/link" ? "/outside/secret" : path),
      stat: () =>
        Effect.succeed({
          type: "File",
          nlink: Option.none()
        } as unknown as EffectFileSystem.File.Info),
      readFile: () =>
        Effect.sync(() => {
          invoked = true
          return new Uint8Array()
        })
    })

    return provide(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        expect(yield* Effect.flip(fileSystem.readFile("link"))).toMatchObject({
          code: "permission_denied",
          capability: { action: "fs:read", resource: "/outside/secret" },
          reason: "denied by test"
        })
        expect(invoked).toBe(false)
        expect(checks).toEqual([{ action: "fs:read", resource: "/outside/secret" }])
      }),
      host,
      scriptedStore(new Set(["fs:read:/workspace/**"]), checks)
    )
  })

  itEffect("resolves a dangling symlink before an outside write creates its target", () => {
    const checks: Array<Capability.Capability> = []
    let invoked = false
    const host = hostFileSystem({
      realPath: (path) =>
        path === "/workspace/link"
          ? Effect.fail(
            new Error("dangling link") as unknown as PlatformError.PlatformError
          )
          : Effect.succeed(path),
      readLink: (path) =>
        path === "/workspace/link"
          ? Effect.succeed("/outside/new-file")
          : Effect.fail(
            new Error("not a link") as unknown as PlatformError.PlatformError
          ),
      writeFile: () =>
        Effect.sync(() => {
          invoked = true
        })
    })

    return provide(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        expect(yield* Effect.flip(fileSystem.writeFile("link", new Uint8Array()))).toMatchObject({
          code: "permission_denied",
          capability: { action: "fs:write", resource: "/outside/new-file" },
          reason: "denied by test"
        })
        expect(invoked).toBe(false)
        expect(checks).toEqual([{ action: "fs:write", resource: "/outside/new-file" }])
      }),
      host,
      scriptedStore(new Set(["fs:write:/workspace/**"]), checks)
    )
  })

  itEffect("fails closed for a pre-existing hard link", () => {
    const checks: Array<Capability.Capability> = []
    let invoked = false
    const host = hostFileSystem({
      stat: () =>
        Effect.succeed({
          type: "File",
          nlink: Option.some(2)
        } as unknown as EffectFileSystem.File.Info),
      writeFile: () =>
        Effect.sync(() => {
          invoked = true
        })
    })

    return provide(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem
        expect(yield* Effect.flip(fileSystem.writeFile("linked", new Uint8Array()))).toMatchObject({
          code: "permission_denied",
          capability: { action: "fs:write", resource: "/workspace/linked" },
          reason: "hard-linked files cannot be confined to the workspace"
        })
        expect(invoked).toBe(false)
        expect(checks).toEqual([])
      }),
      host,
      scriptedStore(new Set(["fs:write:/workspace/linked"]), checks)
    )
  })
})
