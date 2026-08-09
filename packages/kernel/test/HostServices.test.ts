import * as Host from "@smthrs/host"
import * as HostHttpTransport from "@smthrs/host/HttpTransport"
import * as TestHost from "@smthrs/host/test/TestHost"
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
    expect(HostServices.HostServiceTags).toEqual(Host.HostServiceTags)
    expect(HostServices.HostServiceIds).toEqual(Host.HostServiceIds)
    expect(HostServices.ProtectedHostServiceTags).toEqual([
      FileSystem.FileSystem,
      EffectPath.Path,
      Shell.Shell,
      Pty.Pty,
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

      const protectedShell = yield* Shell.Shell
      const rawShell = yield* Host.Shell.Shell
      expect(rawShell).toBe(protectedShell)
      expect(yield* protectedShell.exec("fixture")).toEqual({ stdout: "protected\n", stderr: "", exitCode: 0 })

      const protectedPty = yield* Pty.Pty
      const rawPty = yield* Host.Pty.Pty
      expect(rawPty).toBe(protectedPty)
      expect(yield* Effect.flip(Effect.scoped(protectedPty.spawn("fixture", { cols: 80, rows: 24 }))))
        .toMatchObject({ code: "unsupported", message: "no pty in the browser (requested: fixture)" })

      const protectedJj = yield* Jj.Jj
      const rawJj = yield* Host.Jj.Jj
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

  it("intercepts the underlying @smthrs/host and effect FileSystem tags, not just the kernel decorators", async () => {
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
      expect(yield* Effect.flip(shell.exec("blocked"))).toMatchObject({
        code: "permission_denied",
        capability: { action: "proc:spawn", resource: "blocked" },
        reason: "denied by integration test"
      })
      const pty = yield* Host.Pty.Pty
      expect(yield* Effect.flip(pty.spawn("blocked-pty", { cols: 80, rows: 24 }))).toMatchObject({
        code: "permission_denied",
        capability: { action: "proc:spawn", resource: "blocked-pty" },
        reason: "denied by integration test"
      })
      const jj = yield* Host.Jj.Jj
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
      "proc:spawn",
      "jj:status",
      "fs:read"
    ])
  })
})
