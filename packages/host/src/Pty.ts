/**
 * @since 0.1.0
 *
 * The `Pty` service: a real pseudo-terminal on the host.
 *
 * Contract only; module shape follows `effect/FileSystem` (interface + option
 * types beside the tag, `make` / `makeNoop` / `layerNoop` trio, `layer` left to
 * the platform bundles). The browser bundle implements this by failing with
 * `unsupported` rather than by omitting the service — an absent capability is
 * still a capability with an answer.
 */
import { Context, Effect, Layer } from "effect"
import type { Scope, Stream } from "effect"
import { ptyError } from "./HostError.ts"
import type { PtyError } from "./HostError.ts"

/** @category models */
export interface PtySpawnOptions {
  readonly cols: number
  readonly rows: number
  readonly cwd?: string | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
}

/**
 * A live pseudo-terminal.
 *
 * The handle is scoped: closing the scope — or interrupting the fiber that owns
 * it — kills the process. No AbortSignal.
 *
 * @category models
 */
export interface PtyHandle {
  readonly write: (data: Uint8Array) => Effect.Effect<void, PtyError>
  readonly resize: (cols: number, rows: number) => Effect.Effect<void, PtyError>
  /** Live output from the moment of subscription onward. */
  readonly output: Stream.Stream<Uint8Array, PtyError>
  /**
   * Cursor-replay attach, modelled on opencode's `Pty.attach`: replays the
   * retained buffer from the absolute output cursor `fromCursor`, then
   * continues live. `0` replays everything still retained; a cursor kept from
   * an earlier viewer resumes exactly where it left off. This is what lets a
   * second UI join a running terminal without losing scrollback.
   */
  readonly attach: (fromCursor: number) => Stream.Stream<Uint8Array, PtyError>
  /** Completes when the process exits. */
  readonly exitCode: Effect.Effect<number, PtyError>
}

/** @category services */
export interface Pty {
  readonly spawn: (
    command: string,
    options: PtySpawnOptions
  ) => Effect.Effect<PtyHandle, PtyError, Scope.Scope>
}

/**
 * @category services
 * @since 0.1.0
 */
export const Pty: Context.Service<Pty, Pty> = Context.Service("flows/host/Pty")

/** @category constructors */
export const make = (impl: Pty): Pty => Pty.of(impl)

/**
 * Creates a stub `Pty` for tests and for platforms without one. `spawn` fails
 * with `PtyError` `unsupported` until overridden.
 *
 * @category constructors
 */
export const makeNoop = (overrides: Partial<Pty>): Pty =>
  Pty.of({
    spawn: () =>
      Effect.fail(
        ptyError({
          code: "unsupported",
          method: "spawn",
          description: "no pseudo-terminal in this environment"
        })
      ),
    ...overrides
  })

/** @category layers */
export const layerNoop = (overrides: Partial<Pty>): Layer.Layer<Pty> => Layer.succeed(Pty)(makeNoop(overrides))
