import * as Host from "@smthrs/host"
import * as HostPty from "@smthrs/pty"
import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Capability from "../src/Capability.ts"
import { GrantStore } from "../src/GrantStore.ts"
import { permissionDenied } from "../src/Permission.ts"
import * as Pty from "../src/Pty.ts"
import * as Shell from "../src/Shell.ts"

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
    reply: () => Effect.die("not used by decorator tests"),
    list: Effect.succeed([]),
    grantEnvelope: () => Effect.void
  })

describe("Shell", () => {
  itEffect("checks before exec and does not delegate a denied command", () => {
    let invoked = false
    const checks: Array<Capability.Capability> = []
    const host = Host.Shell.makeNoop({
      exec: () =>
        Effect.sync(() => {
          invoked = true
          return { stdout: "ok", stderr: "", exitCode: 0 }
        })
    })

    return Effect.gen(function*() {
      const shell = yield* Shell.Shell
      expect(yield* Effect.flip(shell.exec("blocked", { cwd: "/work" }))).toMatchObject({
        code: "permission_denied",
        capability: { action: "proc:spawn", resource: "blocked" },
        reason: "denied by test"
      })
      expect(invoked).toBe(false)
      expect(checks).toEqual([{ action: "proc:spawn", resource: "blocked" }])
    }).pipe(
      Effect.provide(Shell.layer),
      Effect.provideService(Host.Shell.Shell, host),
      Effect.provideService(GrantStore, scriptedStore(new Set(), checks))
    )
  })

  itEffect("delegates allowed exec calls without changing their result", () => {
    const checks: Array<Capability.Capability> = []
    const host = Host.Shell.makeNoop({
      exec: () => Effect.succeed({ stdout: "out", stderr: "err", exitCode: 7 })
    })

    return Effect.gen(function*() {
      const shell = yield* Shell.Shell
      expect(yield* shell.exec("tool")).toEqual({ stdout: "out", stderr: "err", exitCode: 7 })
      expect(checks).toEqual([{ action: "proc:spawn", resource: "tool" }])
    }).pipe(
      Effect.provide(Shell.layer),
      Effect.provideService(Host.Shell.Shell, host),
      Effect.provideService(GrantStore, scriptedStore(new Set(["proc:spawn:tool"]), checks))
    )
  })

  itEffect("acquires stream permission only when the stream is consumed", () => {
    let delegated = false
    const checks: Array<Capability.Capability> = []
    const host = Host.Shell.makeNoop({
      stream: () =>
        Stream.fromArray([{ kind: "stdout" as const, chunk: new Uint8Array([1]) }]).pipe(
          Stream.tap(() =>
            Effect.sync(() => {
              delegated = true
            })
          )
        )
    })

    return Effect.gen(function*() {
      const shell = yield* Shell.Shell
      const stream = shell.stream("tool")
      expect(checks).toEqual([])
      expect(delegated).toBe(false)
      expect(yield* Stream.runCollect(stream)).toHaveLength(1)
      expect(checks).toEqual([{ action: "proc:spawn", resource: "tool" }])
      expect(delegated).toBe(true)
    }).pipe(
      Effect.provide(Shell.layer),
      Effect.provideService(Host.Shell.Shell, host),
      Effect.provideService(GrantStore, scriptedStore(new Set(["proc:spawn:tool"]), checks))
    )
  })
})

describe("Pty", () => {
  itEffect("checks once before spawn and returns the host handle unchanged", () => {
    let invoked = false
    const checks: Array<Capability.Capability> = []
    const handle: HostPty.PtyHandle = {
      write: () => Effect.void,
      resize: () => Effect.void,
      output: Stream.empty,
      attach: () => Stream.empty,
      exitCode: Effect.succeed(0)
    }
    const host = HostPty.makeNoop({
      spawn: () =>
        Effect.sync(() => {
          invoked = true
          return handle
        })
    })

    return Effect.gen(function*() {
      const pty = yield* Pty.Pty
      expect(yield* pty.spawn("tool", { cols: 80, rows: 24, cwd: "/work" })).toBe(handle)
      expect(invoked).toBe(true)
      expect(checks).toEqual([{ action: "proc:spawn", resource: "tool" }])
    }).pipe(
      Effect.provide(Pty.layer),
      Effect.provideService(HostPty.Pty, host),
      Effect.provideService(GrantStore, scriptedStore(new Set(["proc:spawn:tool"]), checks)),
      Effect.scoped
    )
  })

  itEffect("does not spawn a denied terminal", () => {
    let invoked = false
    const checks: Array<Capability.Capability> = []
    const host = HostPty.makeNoop({
      spawn: () =>
        Effect.sync(() => {
          invoked = true
          throw new Error("delegate must not run")
        })
    })

    return Effect.gen(function*() {
      const pty = yield* Pty.Pty
      expect(yield* Effect.flip(pty.spawn("blocked", { cols: 80, rows: 24 }))).toMatchObject({
        code: "permission_denied",
        capability: { action: "proc:spawn", resource: "blocked" },
        reason: "denied by test"
      })
      expect(invoked).toBe(false)
      expect(checks).toEqual([{ action: "proc:spawn", resource: "blocked" }])
    }).pipe(
      Effect.provide(Pty.layer),
      Effect.provideService(HostPty.Pty, host),
      Effect.provideService(GrantStore, scriptedStore(new Set(), checks)),
      Effect.scoped
    )
  })
})
