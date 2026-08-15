import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { CapabilityPattern } from "@smthrs/capability-next/Capability"
import { Rule } from "@smthrs/capability-next/Permission"
import { Effect, Fiber, FileSystem as EffectFileSystem, Path as EffectPath } from "effect"
import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as FileSystem from "../src/FileSystem.ts"
import * as GrantStore from "../src/GrantStore.ts"
import * as Workspace from "../src/Workspace.ts"

const directories = new Set<string>()

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "flows-kernel-fs-"))
  directories.add(directory)
  return directory
}

afterEach(async () => {
  await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })))
  directories.clear()
})

const awaitPending = (store: GrantStore.Service): Effect.Effect<GrantStore.PendingRequest> =>
  Effect.suspend(() =>
    Effect.flatMap(store.list, (pending) =>
      pending[0] === undefined
        ? Effect.yieldNow.pipe(Effect.andThen(awaitPending(store)))
        : Effect.succeed(pending[0]))
  )

const withGuardedFileSystem = <A, E>(
  workspaceRoot: string,
  options: GrantStore.MakeOptions,
  use: (store: GrantStore.Service) => Effect.Effect<A, E, EffectFileSystem.FileSystem>
) =>
  Effect.scoped(
    Effect.gen(function*() {
      const store = yield* GrantStore.make(options)
      return yield* use(store).pipe(
        Effect.provide(FileSystem.layer),
        Effect.provide(NodeFileSystem.layer),
        Effect.provide(EffectPath.layer),
        Effect.provideService(GrantStore.GrantStore, store)
      )
    })
  ).pipe(Effect.provide(Workspace.layer(workspaceRoot)))

describe("FileSystem real host confinement", () => {
  // BUG: The delegate opens the logical path after approval, so swapping that
  // path to an outside symlink while `GrantStore.check` is suspended writes
  // through the newly introduced link.
  it.effect.fails("does not follow a symlink swapped in while an attended write is pending", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => temporaryDirectory())
      const workspace = join(directory, "workspace")
      const outside = join(directory, "outside")
      const target = join(workspace, "target.txt")
      const original = join(workspace, "original.txt")
      const secret = join(outside, "secret.txt")
      yield* Effect.promise(() => mkdir(workspace))
      yield* Effect.promise(() => mkdir(outside))
      yield* Effect.promise(() => writeFile(target, "inside", "utf8"))
      yield* Effect.promise(() => writeFile(secret, "outside-original", "utf8"))

      const outcome = yield* (
        withGuardedFileSystem(workspace, {}, (store) =>
          Effect.gen(function*() {
            const fileSystem = yield* EffectFileSystem.FileSystem
            const write = yield* Effect.result(fileSystem.writeFileString(target, "attacker-data")).pipe(
              Effect.forkChild({ startImmediately: true })
            )
            const pending = yield* awaitPending(store)
            expect(pending.capability).toMatchObject({ action: "fs:write", resource: target })

            yield* Effect.promise(() => rename(target, original))
            yield* Effect.promise(() => symlink(secret, target))
            yield* store.reply(pending.requestId, "once")
            return yield* Fiber.join(write)
          }))
      )

      expect(outcome._tag).toBe("Failure")
      expect(yield* Effect.promise(() => readFile(secret, "utf8"))).toBe("outside-original")
    }))

  // BUG: `wrapFile` re-authorizes the current pathname, then delegates to the
  // old descriptor; after rename/rebind that descriptor can name an inode now
  // outside the workspace even though the replacement path is still allowed.
  it.effect.fails("does not authorize an old descriptor by rechecking a rebound pathname", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => temporaryDirectory())
      const workspace = join(directory, "workspace")
      const outside = join(directory, "outside")
      const target = join(workspace, "bound.txt")
      const moved = join(outside, "moved.txt")
      yield* Effect.promise(() => mkdir(workspace))
      yield* Effect.promise(() => mkdir(outside))
      yield* Effect.promise(() => writeFile(target, "inside-original", "utf8"))

      const workspaceFiles = new CapabilityPattern({ action: "fs:*", resource: `${workspace}/**` })
      const outcome = yield* (
        withGuardedFileSystem(workspace, {
          attended: false,
          rules: [new Rule({ effect: "allow", pattern: workspaceFiles })]
        }, () =>
          Effect.scoped(
            Effect.gen(function*() {
              const fileSystem = yield* EffectFileSystem.FileSystem
              const file = yield* fileSystem.open(target, { flag: "r+" })
              yield* Effect.promise(() => rename(target, moved))
              yield* Effect.promise(() => writeFile(target, "replacement", "utf8"))
              return yield* Effect.result(file.writeAll(new TextEncoder().encode("mutated")))
            })
          ))
      )

      expect(outcome._tag).toBe("Failure")
      expect(yield* Effect.promise(() => readFile(moved, "utf8"))).toBe("inside-original")
      yield* Effect.promise(() => unlink(target))
    }))
})
