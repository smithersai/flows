/**
 * Permission-aware shell execution.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md` and
 * `docs/specs/Concepts/Host Adapters.md`.
 *
 * @since 0.1.0
 */
import type { ShellError } from "@flows/host/HostError"
import * as HostShell from "@flows/host/Shell"
import { Context, Effect, Layer, Stream } from "effect"
import { make as makeCapability } from "./Capability.ts"
import { GrantStore } from "./GrantStore.ts"
import type { GrantStoreError, PermissionDenied, PermissionRequired } from "./Permission.ts"

/**
 * A shell service whose commands have passed through the capability kernel.
 *
 * @category services
 * @since 0.1.0
 */
export interface Shell {
  readonly exec: (
    command: string,
    options?: HostShell.ShellOptions
  ) => Effect.Effect<HostShell.ShellResult, ShellError | PermissionRequired | PermissionDenied | GrantStoreError>
  readonly stream: (
    command: string,
    options?: HostShell.ShellOptions
  ) => Stream.Stream<HostShell.ShellChunk, ShellError | PermissionRequired | PermissionDenied | GrantStoreError>
}

/**
 * The permission-aware shell service.
 *
 * @category services
 * @since 0.1.0
 */
export const Shell: Context.Service<Shell, Shell> = Context.Service("@flows/kernel/Shell")

/**
 * Constructs a permission-aware shell service from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (impl: Shell): Shell => Shell.of(impl)

/**
 * Constructs an unavailable permission-aware shell stub.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Shell> = {}): Shell =>
  Shell.of({
    ...HostShell.makeNoop({}),
    ...overrides
  })

/**
 * Provides an unavailable permission-aware shell stub.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<Shell> = {}): Layer.Layer<Shell> =>
  Layer.succeed(Shell)(makeNoop(overrides))

/**
 * Decorates the host shell with a `proc:spawn` capability check.
 *
 * The stream check is acquired with the stream, so merely constructing a
 * stream neither requests permission nor starts a child process.
 *
 * @category layers
 * @since 0.1.0
 */
const layerKernel: Layer.Layer<Shell, never, HostShell.Shell | GrantStore> = Layer.effect(
  Shell,
  Effect.gen(function*() {
    const shell = yield* HostShell.Shell
    const grants = yield* GrantStore
    const check = (command: string, options?: HostShell.ShellOptions) =>
      grants.check(makeCapability("proc:spawn", command), { cwd: options?.cwd })
    return make({
      exec: Effect.fn("Shell.exec")((command, options) =>
        check(command, options).pipe(Effect.andThen(shell.exec(command, options)))
      ),
      stream: (command, options) =>
        Stream.unwrap(
          Effect.fn("Shell.stream")(() =>
            Effect.suspend(() => Effect.map(check(command, options), () => shell.stream(command, options)))
          )()
        )
    })
  })
)

const layerHost: Layer.Layer<HostShell.Shell, never, Shell> = Layer.effect(
  HostShell.Shell,
  Effect.map(Shell, (shell) => shell as unknown as HostShell.Shell)
)

/**
 * Provides the widened kernel tag and replaces the original Host `Shell` tag
 * with the same guarded implementation.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<Shell | HostShell.Shell, never, HostShell.Shell | GrantStore> = Layer.provideMerge(
  layerHost,
  layerKernel
)
