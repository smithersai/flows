import * as Host from "@smithers/host"
import { Effect, FileSystem as EffectFileSystem, Path } from "effect"
import { describe, expect, it } from "vitest"
import type * as Capability from "../src/Capability.ts"
import { GrantStore } from "../src/GrantStore.ts"
import * as Jj from "../src/Jj.ts"
import * as Workspace from "../src/Workspace.ts"

/**
 * The Jj decorator turns each version-control operation into a capability
 * resource. Those resources are the strings an approver sees and a remembered
 * rule matches against, so an unlabelled snapshot and a workspace-relative
 * lane path must both produce stable, canonical resources.
 */

const itEffect = (name: string, effect: () => Effect.Effect<void, unknown, never>) =>
  it(name, () => Effect.runPromise(effect()))

const scriptedStore = (checks: Array<Capability.Capability>) =>
  GrantStore.of({
    check: (capability) => {
      checks.push(capability)
      return Effect.void
    },
    reply: () => Effect.die("not used by decorator tests"),
    list: Effect.succeed([]),
    grantEnvelope: () => Effect.void
  })

const fileSystem = EffectFileSystem.makeNoop({
  realPath: (path) => Effect.succeed(path)
})

const provide = <A, E>(
  effect: Effect.Effect<A, E, Jj.Jj>,
  host: Host.Jj.Jj,
  checks: Array<Capability.Capability>
) =>
  effect.pipe(
    Effect.provide(Jj.layer),
    Effect.provideService(Host.Jj.Jj, host),
    Effect.provideService(EffectFileSystem.FileSystem, fileSystem),
    Effect.provide(Path.layer),
    Effect.provide(Workspace.layer("/workspace")),
    Effect.provideService(GrantStore, scriptedStore(checks))
  )

describe("Jj capability resources", () => {
  itEffect("labels an unnamed snapshot with an empty resource", () => {
    const messages: Array<string | undefined> = []
    const checks: Array<Capability.Capability> = []
    const host = Host.Jj.makeNoop({
      snapshot: (message) =>
        Effect.sync(() => {
          messages.push(message)
          return { changeId: "change" as Host.Jj.ChangeId }
        })
    })

    return provide(
      Effect.gen(function*() {
        const jj = yield* Jj.Jj
        expect(yield* jj.snapshot()).toEqual({ changeId: "change" })
        expect(checks).toEqual([{ action: "jj:snapshot", resource: "" }])
        // The absent message is forwarded as-is; only the resource is defaulted.
        expect(messages).toEqual([undefined])
      }),
      host,
      checks
    )
  })

  itEffect("canonicalizes a workspace-relative workspace-add destination", () => {
    const calls: Array<readonly [string, string]> = []
    const checks: Array<Capability.Capability> = []
    const host = Host.Jj.makeNoop({
      workspaceAdd: (name, destination) =>
        Effect.sync(() => {
          calls.push([name, destination])
        })
    })

    return provide(
      Effect.gen(function*() {
        const jj = yield* Jj.Jj
        yield* jj.workspaceAdd("lane", "lanes/./one")
        expect(checks).toEqual([
          { action: "jj:workspace-add", resource: "/workspace/lanes/one" },
          { action: "fs:write", resource: "/workspace/lanes/one" }
        ])
        expect(calls).toEqual([["lane", "/workspace/lanes/one"]])
      }),
      host,
      checks
    )
  })

  itEffect("keeps an absolute workspace-add destination outside the workspace", () => {
    const calls: Array<readonly [string, string]> = []
    const checks: Array<Capability.Capability> = []
    const host = Host.Jj.makeNoop({
      workspaceAdd: (name, destination) =>
        Effect.sync(() => {
          calls.push([name, destination])
        })
    })

    return provide(
      Effect.gen(function*() {
        const jj = yield* Jj.Jj
        yield* jj.workspaceAdd("lane", "/elsewhere/lane")
        expect(checks.map((check) => check.resource)).toEqual(["/elsewhere/lane", "/elsewhere/lane"])
        expect(calls).toEqual([["lane", "/elsewhere/lane"]])
      }),
      host,
      checks
    )
  })
})

describe("Jj stub layer", () => {
  itEffect("provides an unavailable Jj service", () =>
    Effect.gen(function*() {
      const jj = yield* Jj.Jj
      expect(yield* Effect.flip(jj.status())).toMatchObject({ code: "not_installed", method: "status" })
    }).pipe(Effect.provide(Jj.layerNoop())))

  itEffect("provides overridden operations while the rest stay unavailable", () =>
    Effect.gen(function*() {
      const jj = yield* Jj.Jj
      expect(yield* jj.status()).toBe("clean")
      expect(yield* Effect.flip(jj.snapshot("m"))).toMatchObject({ code: "not_installed" })
    }).pipe(Effect.provide(Jj.layerNoop({ status: () => Effect.succeed("clean") }))))
})
