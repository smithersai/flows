import * as HostJj from "@smthrs/jj"
import { Effect, FileSystem as EffectFileSystem, Option, Path as EffectPath } from "effect"
import * as EffectHttpClient from "effect/unstable/http/HttpClient"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner as EffectChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { describe, expect, it } from "vitest"
import * as Capability from "../src/Capability.ts"
import * as ChildProcessSpawner from "../src/ChildProcessSpawner.ts"
import * as FileSystem from "../src/FileSystem.ts"
import { GrantStore } from "../src/GrantStore.ts"
import * as HostServices from "../src/HostServices.ts"
import * as HttpClient from "../src/HttpClient.ts"
import * as HostHttpTransport from "../src/HttpTransport.ts"
import * as Jj from "../src/Jj.ts"
import { permissionDenied } from "../src/Permission.ts"
import * as TestHost from "../src/test/TestHost.ts"
import * as Workspace from "../src/Workspace.ts"

const allowAll = GrantStore.of({
  check: () => Effect.void,
  reply: () => Effect.die("not used by aggregate-layer tests"),
  list: Effect.succeed([]),
  grantEnvelope: () => Effect.void
})

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
  it("shares the complete platform-port list and maps every slot to one protected tag", () => {
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
      "flows/host/Jj",
      "flows/host/HttpTransport"
    ])
    expect(HostServices.ProtectedHostServiceTags).toEqual([
      FileSystem.FileSystem,
      EffectPath.Path,
      ChildProcessSpawner.ChildProcessSpawner,
      Jj.Jj,
      HttpClient.HttpClient
    ])
  })

  it("binds every raw alias to its protected implementation and preserves host behavior", async () => {
    const http = EffectHttpClient.make((request) => Effect.succeed({ status: 200, headers: {}, request } as never))
    const program = Effect.gen(function*() {
      const protectedFileSystem = yield* FileSystem.FileSystem
      const rawFileSystem = yield* EffectFileSystem.FileSystem
      expect(rawFileSystem).toBe(protectedFileSystem)
      expect(Array.from(yield* protectedFileSystem.readFile("/workspace/.keep"))).toEqual([])

      const path = yield* EffectPath.Path
      expect(path.normalize("/workspace/src/../src")).toBe("/workspace/src")

      const protectedSpawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const rawSpawner = yield* EffectChildProcessSpawner
      expect(rawSpawner).toBe(protectedSpawner)
      expect(yield* protectedSpawner.string(ChildProcess.make("fixture"))).toBe("protected\n")

      const protectedJj = yield* Jj.Jj
      const rawJj = yield* HostJj.Jj
      expect(rawJj).toBe(protectedJj)
      expect(yield* Effect.flip(protectedJj.status())).toMatchObject({
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

  it("intercepts the underlying platform tags, not just the kernel decorators", async () => {
    const checks: Array<Capability.Capability> = []
    const deny = GrantStore.of({
      check: (capability) => {
        checks.push(capability)
        return Effect.fail(permissionDenied(capability, "denied by integration test"))
      },
      reply: () => Effect.die("not used by aggregate-layer tests"),
      list: Effect.succeed([]),
      grantEnvelope: () => Effect.void
    })
    const http = EffectHttpClient.make((request) => Effect.succeed({ status: 200, headers: {}, request } as never))
    const program = Effect.gen(function*() {
      const spawner = yield* EffectChildProcessSpawner
      expect(yield* Effect.flip(spawner.string(ChildProcess.make("blocked")))).toMatchObject({
        code: "permission_denied",
        capability: { action: "proc:spawn", resource: "blocked" },
        reason: "denied by integration test"
      })
      const jj = yield* HostJj.Jj
      expect(yield* Effect.flip(jj.status())).toMatchObject({
        code: "permission_denied",
        capability: { action: "jj:status", resource: "." },
        reason: "denied by integration test"
      })
      const protectedFileSystem = yield* EffectFileSystem.FileSystem
      expect(yield* Effect.flip(protectedFileSystem.readFile("/workspace/.keep"))).toMatchObject({
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
