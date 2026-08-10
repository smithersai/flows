/**
 * Permission-aware process spawning.
 *
 * `flows` has no shell service of its own — process execution is Effect's
 * `effect/unstable/process`. The only thing the kernel adds is the
 * `proc:spawn` capability check, applied to the one primitive every other
 * helper is derived from.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md` and
 * `docs/specs/Concepts/Host Adapters.md`.
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { systemError } from "effect/PlatformError"
import type * as Scope from "effect/Scope"
import type * as Stream from "effect/Stream"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessHandle, ExitCode } from "effect/unstable/process/ChildProcessSpawner"
import {
  ChildProcessSpawner as HostChildProcessSpawner,
  make as makeSpawner
} from "effect/unstable/process/ChildProcessSpawner"
import { make as makeCapability } from "./Capability.ts"
import * as CommandLine from "./CommandLine.ts"
import { GrantStore } from "./GrantStore.ts"
import type { GrantStoreError, PermissionDenied, PermissionRequired } from "./Permission.ts"

/**
 * Everything a guarded spawn can fail with: the platform's own failures, plus
 * the three the capability kernel adds. Widening the error channel here is the
 * whole point of the kernel tag — a caller that holds it cannot forget that a
 * command may be denied.
 *
 * @category models
 * @since 0.1.0
 */
export type SpawnError = PlatformError | PermissionRequired | PermissionDenied | GrantStoreError

/**
 * Output selection shared by the streaming and buffered helpers.
 *
 * @category models
 * @since 0.1.0
 */
export interface OutputOptions {
  readonly includeStderr?: boolean | undefined
}

/**
 * A process spawner whose commands have passed through the capability kernel.
 *
 * The shape mirrors Effect's `ChildProcessSpawner` exactly; only the error
 * channel differs.
 *
 * @category services
 * @since 0.1.0
 */
export interface ChildProcessSpawner {
  readonly spawn: (
    command: ChildProcess.Command
  ) => Effect.Effect<ChildProcessHandle, SpawnError, Scope.Scope>
  readonly exitCode: (command: ChildProcess.Command) => Effect.Effect<ExitCode, SpawnError>
  readonly streamString: (
    command: ChildProcess.Command,
    options?: OutputOptions
  ) => Stream.Stream<string, SpawnError>
  readonly streamLines: (
    command: ChildProcess.Command,
    options?: OutputOptions
  ) => Stream.Stream<string, SpawnError>
  readonly lines: (
    command: ChildProcess.Command,
    options?: OutputOptions
  ) => Effect.Effect<Array<string>, SpawnError>
  readonly string: (
    command: ChildProcess.Command,
    options?: OutputOptions
  ) => Effect.Effect<string, SpawnError>
}

/**
 * The permission-aware process spawner service.
 *
 * @category services
 * @since 0.1.0
 */
export const ChildProcessSpawner: Context.Service<ChildProcessSpawner, ChildProcessSpawner> = Context.Service(
  "@smthrs/kernel/ChildProcessSpawner"
)

/**
 * Constructs a permission-aware spawner from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (impl: ChildProcessSpawner): ChildProcessSpawner => ChildProcessSpawner.of(impl)

/**
 * Derives the full six-method surface from one `spawn`, the way
 * `ChildProcessSpawner.make` does, so `exitCode`, `string`, `lines`, and both
 * `stream*` helpers can never bypass whatever `spawn` was given.
 */
const deriveFrom = (
  spawn: ChildProcessSpawner["spawn"]
): ChildProcessSpawner =>
  // The cast is one-way only: the derived helpers keep the narrower
  // `PlatformError` channel Effect declares, which the kernel interface widens.
  make(makeSpawner(spawn as unknown as HostChildProcessSpawner["Service"]["spawn"]))

/**
 * Constructs an unavailable permission-aware spawner stub.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<ChildProcessSpawner> = {}): ChildProcessSpawner =>
  ChildProcessSpawner.of({
    ...deriveFrom((command) =>
      Effect.fail(
        systemError({
          _tag: "NotFound",
          module: "ChildProcessSpawner",
          method: "spawn",
          description: `no process host for \`${CommandLine.render(command)}\``
        })
      )
    ),
    ...overrides
  })

/**
 * Provides an unavailable permission-aware spawner stub.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<ChildProcessSpawner> = {}): Layer.Layer<ChildProcessSpawner> =>
  Layer.succeed(ChildProcessSpawner)(makeNoop(overrides))

/**
 * Decorates the host spawner with a `proc:spawn` capability check.
 *
 * The check is suspended into the spawn itself, so building a `Command` or a
 * stream neither requests permission nor starts a process; only running one
 * does. The capability resource is the command line `CommandLine.render`
 * produces, which is also what a browser host would execute — a grant and the
 * thing it authorizes read the same.
 *
 * @category layers
 * @since 0.1.0
 */
const layerKernel: Layer.Layer<ChildProcessSpawner, never, HostChildProcessSpawner | GrantStore> = Layer.effect(
  ChildProcessSpawner,
  Effect.gen(function*() {
    const spawner = yield* HostChildProcessSpawner
    const grants = yield* GrantStore
    const check = (command: ChildProcess.Command) =>
      Effect.suspend(() =>
        grants.check(makeCapability("proc:spawn", CommandLine.render(command)), {
          cwd: CommandLine.cwd(command)
        })
      )
    return deriveFrom(
      Effect.fn("ChildProcessSpawner.spawn")((command: ChildProcess.Command) =>
        check(command).pipe(Effect.andThen(spawner.spawn(command)))
      )
    )
  })
)

const layerHost: Layer.Layer<HostChildProcessSpawner, never, ChildProcessSpawner> = Layer.effect(
  HostChildProcessSpawner,
  Effect.map(
    ChildProcessSpawner,
    (spawner) => spawner as unknown as HostChildProcessSpawner["Service"]
  )
)

/**
 * Provides the widened kernel tag and replaces Effect's own
 * `ChildProcessSpawner` tag with the same guarded implementation, so a
 * `ChildProcess.Command` run as a plain `Effect` is checked too.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<
  ChildProcessSpawner | HostChildProcessSpawner,
  never,
  HostChildProcessSpawner | GrantStore
> = Layer.provideMerge(layerHost, layerKernel)
