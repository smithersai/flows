import * as Host from "@flows/host"
import * as HostHttpTransport from "@flows/host/HttpTransport"
import { Effect, FileSystem as EffectFileSystem, Option, Path as EffectPath } from "effect"
import * as EffectHttpClient from "effect/unstable/http/HttpClient"
import { describe, expect, it } from "vitest"
import * as Capability from "../src/Capability.ts"
import * as FileSystem from "../src/FileSystem.ts"
import { GrantStore } from "../src/GrantStore.ts"
import * as HostServices from "../src/HostServices.ts"
import * as HttpClient from "../src/HttpClient.ts"
import * as Jj from "../src/Jj.ts"
import { permissionDenied } from "../src/Permission.ts"
import * as Pty from "../src/Pty.ts"
import * as Shell from "../src/Shell.ts"
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
    expect(HostServices.HostServiceTags).toHaveLength(6)
    expect(new Set(HostServices.HostServiceTags)).toHaveLength(6)
    expect(HostServices.HostServiceTags).toContain(HostHttpTransport.HttpTransport)
    expect(HostServices.HostServiceIds).toEqual(Host.HostServiceIds)
    expect(HostServices.ProtectedHostServiceTags).toHaveLength(HostServices.HostServiceIds.length)
    expect(new Set(HostServices.ProtectedHostServiceTags)).toHaveLength(HostServices.HostServiceIds.length)
    expect(HostServices.ProtectedHostServiceTags).toContain(HttpClient.HttpClient)
    expect(HostServices.ProtectedHostServiceTags).not.toContain(HostHttpTransport.HttpTransport)
  })

  it("builds every protected service over a host bundle", async () => {
    const http = EffectHttpClient.make((request) => Effect.succeed({ status: 200, headers: {}, request } as never))
    const program = Effect.gen(function*() {
      expect(yield* FileSystem.FileSystem).toBeDefined()
      expect(yield* EffectFileSystem.FileSystem).toBeDefined()
      expect(yield* EffectPath.Path).toBeDefined()
      expect(yield* Shell.Shell).toBeDefined()
      expect(yield* Host.Shell.Shell).toBeDefined()
      expect(yield* Pty.Pty).toBeDefined()
      expect(yield* Host.Pty.Pty).toBeDefined()
      expect(yield* Jj.Jj).toBeDefined()
      expect(yield* Host.Jj.Jj).toBeDefined()
      expect(yield* HttpClient.HttpClient).toBeDefined()
    }).pipe(
      Effect.provide(HostServices.layer),
      Effect.provideService(EffectFileSystem.FileSystem, fileSystem),
      Effect.provide(Host.TestHost.layer({ files: { "/workspace/.keep": "" } })),
      Effect.provideService(HostHttpTransport.HttpTransport, HostHttpTransport.make(http.execute)),
      Effect.provide(Workspace.layer("/workspace")),
      Effect.provideService(GrantStore, allowAll)
    )
    await Effect.runPromise(program)
  })

  it("intercepts legacy Host and filesystem tags still exposed by their decorators", async () => {
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
      const shell = yield* Host.Shell.Shell
      yield* Effect.exit(shell.exec("blocked"))
      const pty = yield* Host.Pty.Pty
      yield* Effect.exit(pty.spawn("blocked-pty", { cols: 80, rows: 24 }))
      const jj = yield* Host.Jj.Jj
      yield* Effect.exit(jj.status())
      const fileSystem = yield* EffectFileSystem.FileSystem
      yield* Effect.exit(fileSystem.readFile("/workspace/.keep"))
    }).pipe(
      Effect.provide(HostServices.layer),
      Effect.provideService(EffectFileSystem.FileSystem, fileSystem),
      Effect.provide(Host.TestHost.layer({ files: { "/workspace/.keep": "" } })),
      Effect.provideService(HostHttpTransport.HttpTransport, HostHttpTransport.make(http.execute)),
      Effect.provide(Workspace.layer("/workspace")),
      Effect.provideService(GrantStore, deny),
      Effect.scoped
    )

    await Effect.runPromise(program)
    expect(checks.map((capability) => capability.action)).toEqual([
      "proc:spawn",
      "proc:spawn",
      "jj:status",
      "fs:read"
    ])
  })
})
