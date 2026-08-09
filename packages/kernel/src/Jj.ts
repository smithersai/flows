/**
 * Permission-aware Jujutsu version-control operations.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md`,
 * `docs/specs/Concepts/Effect Taxonomy.md`, and
 * `docs/specs/Concepts/Host Adapters.md`.
 *
 * @since 0.1.0
 */
import type { JjError } from "@smthrs/host/HostError"
import * as HostJj from "@smthrs/host/Jj"
import { Context, Effect, FileSystem as EffectFileSystem, Layer, Path as EffectPath, type PlatformError } from "effect"
import { make as makeCapability } from "./Capability.ts"
import { canonicalResource } from "./FileSystem.ts"
import { GrantStore } from "./GrantStore.ts"
import type { GrantStoreError, PermissionDenied, PermissionRequired } from "./Permission.ts"
import { Workspace } from "./Workspace.ts"

/**
 * A Jujutsu service whose operations have passed through the capability
 * kernel.
 *
 * @category services
 * @since 0.1.0
 */
export interface Jj {
  readonly snapshot: (
    message?: string
  ) => Effect.Effect<
    { readonly changeId: HostJj.ChangeId },
    JjError | PermissionRequired | PermissionDenied | GrantStoreError
  >
  readonly restore: (
    changeId: HostJj.ChangeId
  ) => Effect.Effect<void, JjError | PermissionRequired | PermissionDenied | GrantStoreError>
  readonly diff: (
    from: HostJj.ChangeId,
    to: HostJj.ChangeId
  ) => Effect.Effect<string, JjError | PermissionRequired | PermissionDenied | GrantStoreError>
  readonly workspaceAdd: (
    name: string,
    path: string
  ) => Effect.Effect<
    void,
    JjError | PlatformError.PlatformError | PermissionRequired | PermissionDenied | GrantStoreError
  >
  readonly workspaceForget: (
    name: string
  ) => Effect.Effect<void, JjError | PermissionRequired | PermissionDenied | GrantStoreError>
  readonly status: () => Effect.Effect<string, JjError | PermissionRequired | PermissionDenied | GrantStoreError>
}

/**
 * The permission-aware Jujutsu service.
 *
 * @category services
 * @since 0.1.0
 */
export const Jj: Context.Service<Jj, Jj> = Context.Service("@smthrs/kernel/Jj")

/**
 * Constructs a permission-aware Jujutsu service from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (impl: Jj): Jj => Jj.of(impl)

/**
 * Constructs an unavailable permission-aware Jujutsu stub.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Jj> = {}): Jj =>
  Jj.of({
    ...HostJj.makeNoop({}),
    ...overrides
  })

/**
 * Provides an unavailable permission-aware Jujutsu stub.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<Jj> = {}): Layer.Layer<Jj> => Layer.succeed(Jj)(makeNoop(overrides))

/**
 * Decorates the host Jujutsu service with operation-specific capability checks.
 *
 * @category layers
 * @since 0.1.0
 */
const layerKernel: Layer.Layer<
  Jj,
  never,
  HostJj.Jj | EffectFileSystem.FileSystem | EffectPath.Path | Workspace | GrantStore
> = Layer.effect(
  Jj,
  Effect.gen(function*() {
    const jj = yield* HostJj.Jj
    const fileSystem = yield* EffectFileSystem.FileSystem
    const path = yield* EffectPath.Path
    const workspace = yield* Workspace
    const grants = yield* GrantStore
    return make({
      status: Effect.fn("Jj.status")(() =>
        grants.check(makeCapability("jj:status", ".")).pipe(Effect.andThen(jj.status()))
      ),
      diff: Effect.fn("Jj.diff")((from, to) =>
        grants.check(makeCapability("jj:diff", `${from}:${to}`)).pipe(Effect.andThen(jj.diff(from, to)))
      ),
      snapshot: Effect.fn("Jj.snapshot")((message) =>
        grants.check(makeCapability("jj:snapshot", message ?? "")).pipe(Effect.andThen(jj.snapshot(message)))
      ),
      restore: Effect.fn("Jj.restore")((changeId) =>
        grants.check(makeCapability("jj:restore", changeId)).pipe(Effect.andThen(jj.restore(changeId)))
      ),
      workspaceAdd: Effect.fn("Jj.workspaceAdd")((name, destination) =>
        canonicalResource(fileSystem, path, workspace.root, destination).pipe(
          Effect.flatMap((resource) =>
            grants.check(makeCapability("jj:workspace-add", resource)).pipe(
              Effect.andThen(grants.check(makeCapability("fs:write", resource))),
              Effect.andThen(
                jj.workspaceAdd(
                  name,
                  path.normalize(path.isAbsolute(destination) ? destination : path.resolve(workspace.root, destination))
                )
              )
            )
          )
        )
      ),
      workspaceForget: Effect.fn("Jj.workspaceForget")((name) =>
        grants.check(makeCapability("jj:workspace-forget", name)).pipe(Effect.andThen(jj.workspaceForget(name)))
      )
    })
  })
)

const layerHost: Layer.Layer<HostJj.Jj, never, Jj> = Layer.effect(
  HostJj.Jj,
  Effect.map(Jj, (jj) => jj as unknown as HostJj.Jj)
)

/**
 * Provides the widened kernel tag and replaces the original Host `Jj` tag
 * with the same guarded implementation.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<
  Jj | HostJj.Jj,
  never,
  HostJj.Jj | EffectFileSystem.FileSystem | EffectPath.Path | Workspace | GrantStore
> = Layer.provideMerge(layerHost, layerKernel)
