/**
 * Permission-aware pseudo-terminal creation.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md` and
 * `docs/specs/Concepts/Host Adapters.md`.
 *
 * @since 0.1.0
 */
import type { PtyError } from "@smthrs/host/HostError"
import * as HostPty from "@smthrs/host/Pty"
import { Context, Effect, Layer } from "effect"
import type * as Scope from "effect/Scope"
import { make as makeCapability } from "./Capability.ts"
import { GrantStore } from "./GrantStore.ts"
import type { GrantStoreError, PermissionDenied, PermissionRequired } from "./Permission.ts"

/**
 * A pseudo-terminal service whose process creation has passed through the
 * capability kernel.
 *
 * @category services
 * @since 0.1.0
 */
export interface Pty {
  readonly spawn: (
    command: string,
    options: HostPty.PtySpawnOptions
  ) => Effect.Effect<
    HostPty.PtyHandle,
    PtyError | PermissionRequired | PermissionDenied | GrantStoreError,
    Scope.Scope
  >
}

/**
 * The permission-aware pseudo-terminal service.
 *
 * @category services
 * @since 0.1.0
 */
export const Pty: Context.Service<Pty, Pty> = Context.Service("@smthrs/kernel/Pty")

/**
 * Constructs a permission-aware pseudo-terminal service from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (impl: Pty): Pty => Pty.of(impl)

/**
 * Constructs an unavailable permission-aware pseudo-terminal stub.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Pty> = {}): Pty =>
  Pty.of({
    ...HostPty.makeNoop({}),
    ...overrides
  })

/**
 * Provides an unavailable permission-aware pseudo-terminal stub.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<Pty> = {}): Layer.Layer<Pty> => Layer.succeed(Pty)(makeNoop(overrides))

/**
 * Decorates the host pseudo-terminal with a `proc:spawn` capability check.
 * Returned handles are deliberately not wrapped: authorization belongs to the
 * admitted spawn and their original scope owns their finalization.
 *
 * @category layers
 * @since 0.1.0
 */
const layerKernel: Layer.Layer<Pty, never, HostPty.Pty | GrantStore> = Layer.effect(
  Pty,
  Effect.gen(function*() {
    const pty = yield* HostPty.Pty
    const grants = yield* GrantStore
    return make({
      spawn: Effect.fn("Pty.spawn")((command, options) =>
        grants.check(makeCapability("proc:spawn", command), { cwd: options.cwd }).pipe(
          Effect.andThen(pty.spawn(command, options))
        )
      )
    })
  })
)

const layerHost: Layer.Layer<HostPty.Pty, never, Pty> = Layer.effect(
  HostPty.Pty,
  Effect.map(Pty, (pty) => pty as unknown as HostPty.Pty)
)

/**
 * Provides the widened kernel tag and replaces the original Host `Pty` tag
 * with the same guarded implementation.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<Pty | HostPty.Pty, never, HostPty.Pty | GrantStore> = Layer.provideMerge(
  layerHost,
  layerKernel
)
