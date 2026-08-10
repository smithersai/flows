import * as PtyPort from "@smthrs/pty"
import { Effect, Sink, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import {
  ChildProcessSpawner as HostChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId
} from "effect/unstable/process/ChildProcessSpawner"
import { describe, expect, it } from "vitest"
import * as Capability from "../src/Capability.ts"
import * as ChildProcessSpawner from "../src/ChildProcessSpawner.ts"
import { GrantStore } from "../src/GrantStore.ts"
import { permissionDenied } from "../src/Permission.ts"
import * as Pty from "../src/Pty.ts"

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

/** A host spawner whose handle just replays a scripted stdout. */
const hostSpawner = (options: { readonly stdout: string; readonly onSpawn?: () => void }) =>
  makeSpawner(() =>
    Effect.sync(() => {
      options.onSpawn?.()
      const output = Stream.fromArray([new TextEncoder().encode(options.stdout)])
      return makeHandle({
        pid: ProcessId(1),
        exitCode: Effect.succeed(ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: output,
        stderr: Stream.empty,
        all: output,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void)
      })
    })
  )

describe("ChildProcessSpawner", () => {
  itEffect("checks before spawning and does not delegate a denied command", () => {
    let invoked = false
    const checks: Array<Capability.Capability> = []

    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      expect(
        yield* Effect.flip(
          spawner.string(ChildProcess.make("blocked", ["--now"], { cwd: "/work" }))
        )
      ).toMatchObject({
        code: "permission_denied",
        capability: { action: "proc:spawn", resource: "blocked --now" },
        reason: "denied by test"
      })
      expect(invoked).toBe(false)
      expect(checks).toEqual([{ action: "proc:spawn", resource: "blocked --now" }])
    }).pipe(
      Effect.provide(ChildProcessSpawner.layer),
      Effect.provideService(
        HostChildProcessSpawner,
        hostSpawner({ stdout: "never", onSpawn: () => (invoked = true) })
      ),
      Effect.provideService(GrantStore, scriptedStore(new Set(), checks))
    )
  })

  itEffect("delegates allowed commands without changing their result", () => {
    const checks: Array<Capability.Capability> = []

    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      expect(yield* spawner.string(ChildProcess.make("tool"))).toBe("out")
      expect(checks).toEqual([{ action: "proc:spawn", resource: "tool" }])
    }).pipe(
      Effect.provide(ChildProcessSpawner.layer),
      Effect.provideService(HostChildProcessSpawner, hostSpawner({ stdout: "out" })),
      Effect.provideService(GrantStore, scriptedStore(new Set(["proc:spawn:tool"]), checks))
    )
  })

  itEffect("checks every derived helper, not just `spawn`", () => {
    const checks: Array<Capability.Capability> = []

    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const command = ChildProcess.make("tool")
      yield* Effect.scoped(spawner.spawn(command))
      yield* spawner.exitCode(command)
      yield* spawner.string(command)
      yield* spawner.lines(command)
      yield* Stream.runDrain(spawner.streamString(command))
      yield* Stream.runDrain(spawner.streamLines(command))
      expect(checks).toHaveLength(6)
    }).pipe(
      Effect.provide(ChildProcessSpawner.layer),
      Effect.provideService(HostChildProcessSpawner, hostSpawner({ stdout: "out" })),
      Effect.provideService(GrantStore, scriptedStore(new Set(["proc:spawn:tool"]), checks))
    )
  })

  itEffect("acquires stream permission only when the stream is consumed", () => {
    let delegated = false
    const checks: Array<Capability.Capability> = []

    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const stream = spawner.streamString(ChildProcess.make("tool"))
      expect(checks).toEqual([])
      expect(delegated).toBe(false)
      expect(yield* Stream.mkString(stream)).toBe("out")
      expect(checks).toEqual([{ action: "proc:spawn", resource: "tool" }])
      expect(delegated).toBe(true)
    }).pipe(
      Effect.provide(ChildProcessSpawner.layer),
      Effect.provideService(
        HostChildProcessSpawner,
        hostSpawner({ stdout: "out", onSpawn: () => (delegated = true) })
      ),
      Effect.provideService(GrantStore, scriptedStore(new Set(["proc:spawn:tool"]), checks))
    )
  })

  itEffect("republishes the guarded implementation on Effect's own spawner tag", () => {
    const checks: Array<Capability.Capability> = []

    return Effect.gen(function*() {
      const kernel = yield* ChildProcessSpawner.ChildProcessSpawner
      const raw = yield* HostChildProcessSpawner
      expect(raw).toBe(kernel)
      expect(yield* Effect.flip(raw.string(ChildProcess.make("blocked")))).toMatchObject({
        code: "permission_denied"
      })
    }).pipe(
      Effect.provide(ChildProcessSpawner.layer),
      Effect.provideService(HostChildProcessSpawner, hostSpawner({ stdout: "out" })),
      Effect.provideService(GrantStore, scriptedStore(new Set(), checks))
    )
  })

  itEffect("passes the command's cwd to the grant check", () => {
    const seen: Array<unknown> = []
    const store = GrantStore.of({
      check: (capability, context) => {
        seen.push({ capability, context })
        return Effect.void
      },
      reply: () => Effect.die("not used by decorator tests"),
      list: Effect.succeed([]),
      grantEnvelope: () => Effect.void
    })

    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      yield* spawner.string(ChildProcess.make("tool", [], { cwd: "/work" }))
      expect(seen).toEqual([{
        capability: { action: "proc:spawn", resource: "tool" },
        context: { cwd: "/work" }
      }])
    }).pipe(
      Effect.provide(ChildProcessSpawner.layer),
      Effect.provideService(HostChildProcessSpawner, hostSpawner({ stdout: "out" })),
      Effect.provideService(GrantStore, store)
    )
  })
})

describe("Pty", () => {
  itEffect("checks once before spawn and returns the host handle unchanged", () => {
    let invoked = false
    const checks: Array<Capability.Capability> = []
    const handle: PtyPort.PtyHandle = {
      write: () => Effect.void,
      resize: () => Effect.void,
      output: Stream.empty,
      attach: () => Stream.empty,
      exitCode: Effect.succeed(0)
    }
    const host = PtyPort.makeNoop({
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
      Effect.provideService(PtyPort.Pty, host),
      Effect.provideService(GrantStore, scriptedStore(new Set(["proc:spawn:tool"]), checks)),
      Effect.scoped
    )
  })

  itEffect("does not spawn a denied terminal", () => {
    let invoked = false
    const checks: Array<Capability.Capability> = []
    const host = PtyPort.makeNoop({
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
      Effect.provideService(PtyPort.Pty, host),
      Effect.provideService(GrantStore, scriptedStore(new Set(), checks)),
      Effect.scoped
    )
  })
})
