import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import * as HostJj from "@smthrs/jj"
import { Effect, FileSystem as EffectFileSystem, Option, Path as EffectPath, type PlatformError } from "effect"
import * as EffectHttpClient from "effect/unstable/http/HttpClient"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner as EffectChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { describe, expect, it } from "vitest"
import { GrantStore } from "../src/GrantStore.ts"
import * as HostServices from "../src/HostServices.ts"
import * as HttpClient from "../src/HttpClient.ts"
import * as HostHttpTransport from "../src/HttpTransport.ts"
import * as TestHost from "../src/test/TestHost.ts"
import * as Workspace from "../src/Workspace.ts"

const allowAll = GrantStore.of({
  check: () => Effect.void,
  reply: () => Effect.die("not used by aggregate-layer tests"),
  list: Effect.succeed([]),
  grantEnvelope: () => Effect.void
})

const denial = (error: unknown) => Option.getOrThrow(Permission.fromPlatformError(error as PlatformError.PlatformError))

const fileSystem = EffectFileSystem.makeNoop({
  realPath: (path) => Effect.succeed(path),
  stat: (path) =>
    Effect.succeed({
      type: path === "/workspace" ? "Directory" : "File",
      nlink: Option.none()
    } as EffectFileSystem.File.Info),
  readFile: () => Effect.succeed(new Uint8Array())
})

describe("HostServices", () => {
  it("shares one closed platform-port list with one tag per slot", () => {
    expect(HostServices.HostServiceTags).toEqual([
      EffectFileSystem.FileSystem,
      EffectPath.Path,
      EffectChildProcessSpawner,
      HostJj.Jj,
      HostHttpTransport.HttpTransport
    ])
    expect(HostServices.HostServiceIds).toEqual([
      "effect/FileSystem",
      "effect/Path",
      "effect/process/ChildProcessSpawner",
      "@smthrs/jj/Jj",
      "@smthrs/kernel/HttpTransport"
    ])
    expect(HostServices.HostServiceTags).toHaveLength(HostServices.HostServiceIds.length)
    // There is no second, "protected" tag list to keep in slot order with this
    // one: the kernel decorates each tag above in place.
    expect(HostServices).not.toHaveProperty("ProtectedHostServiceTags")
  })

  it("replaces each platform tag with its guarded implementation and preserves host behavior", async () => {
    const http = EffectHttpClient.make((request) => Effect.succeed({ status: 200, headers: {}, request } as never))
    const program = Effect.gen(function*() {
      const guardedFileSystem = yield* EffectFileSystem.FileSystem
      expect(Array.from(yield* guardedFileSystem.readFile("/workspace/.keep"))).toEqual([])

      const path = yield* EffectPath.Path
      expect(path.normalize("/workspace/src/../src")).toBe("/workspace/src")

      const spawner = yield* EffectChildProcessSpawner
      expect(yield* spawner.string(ChildProcess.make("fixture"))).toBe("protected\n")

      const jj = yield* HostJj.Jj
      expect(yield* Effect.flip(jj.status())).toMatchObject({
        code: "not_installed",
        command: "jj status",
        message: "jj is not available in the browser"
      })

      const client = yield* HttpClient.HttpClient
      expect((yield* client.get("https://example.test/health")).status).toBe(200)
    }).pipe(
      Effect.provide(HostServices.layer),
      Effect.provideService(EffectFileSystem.FileSystem, fileSystem),
      Effect.provideService(HostHttpTransport.HttpTransport, HostHttpTransport.make(http.execute)),
      Effect.provide(TestHost.layer({
        files: { "/workspace/.keep": "" },
        commands: { fixture: { stdout: "protected\n" } }
      })),
      Effect.provide(Workspace.layer("/workspace")),
      Effect.provideService(GrantStore, allowAll)
    )
    await Effect.runPromise(program)
  })

  it("intercepts the underlying platform tags, so a kernel-unaware consumer is guarded too", async () => {
    const checks: Array<Capability.Capability> = []
    const deny = GrantStore.of({
      check: (capability) => {
        checks.push(capability)
        return Effect.fail(Permission.permissionDenied(capability, "denied by integration test"))
      },
      reply: () => Effect.die("not used by aggregate-layer tests"),
      list: Effect.succeed([]),
      grantEnvelope: () => Effect.void
    })
    const http = EffectHttpClient.make((request) => Effect.succeed({ status: 200, headers: {}, request } as never))
    const program = Effect.gen(function*() {
      const spawner = yield* EffectChildProcessSpawner
      const spawnFailure = yield* Effect.flip(spawner.string(ChildProcess.make("blocked")))
      expect(spawnFailure).toMatchObject({
        _tag: "PlatformError",
        reason: { _tag: "PermissionDenied", module: "ChildProcessSpawner", method: "spawn" }
      })
      expect(denial(spawnFailure)).toMatchObject({
        code: "permission_denied",
        capability: { action: "proc:spawn", resource: "blocked" },
        reason: "denied by integration test"
      })

      // `flows` owns `Jj`, so its interface names the kernel failure directly
      // instead of projecting it into a `PlatformError`.
      const jj = yield* HostJj.Jj
      expect(yield* Effect.flip(jj.status())).toMatchObject({
        code: "permission_denied",
        capability: { action: "jj:status", resource: "." },
        reason: "denied by integration test"
      })

      const guardedFileSystem = yield* EffectFileSystem.FileSystem
      const readFailure = yield* Effect.flip(guardedFileSystem.readFile("/workspace/.keep"))
      expect(readFailure).toMatchObject({
        _tag: "PlatformError",
        reason: { _tag: "PermissionDenied", module: "FileSystem", method: "read" }
      })
      expect(denial(readFailure)).toMatchObject({
        code: "permission_denied",
        capability: { action: "fs:read", resource: "/workspace/.keep" },
        reason: "denied by integration test"
      })
    }).pipe(
      Effect.provide(HostServices.layer),
      Effect.provideService(EffectFileSystem.FileSystem, fileSystem),
      Effect.provideService(HostHttpTransport.HttpTransport, HostHttpTransport.make(http.execute)),
      Effect.provide(TestHost.layer({ files: { "/workspace/.keep": "" } })),
      Effect.provide(Workspace.layer("/workspace")),
      Effect.provideService(GrantStore, deny),
      Effect.scoped
    )

    await Effect.runPromise(program)
    expect(checks.map((capability) => capability.action)).toEqual([
      "proc:spawn",
      "jj:status",
      "fs:read"
    ])
  })
})
