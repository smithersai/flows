/**
 * Governing plan:
 * `docs/specs/Research/Agent Ecosystem Plan 2026-07-28.md`.
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer } from "effect"
import * as StdError from "./StdError.ts"

/** @category models @since 0.1.0 */
export interface Position {
  readonly path: string
  readonly line: number
  readonly character: number
}
/** @category models @since 0.1.0 */
export interface LanguageServer {
  readonly hover: (position: Position) => Effect.Effect<unknown, StdError.StdError>
  readonly definition: (position: Position) => Effect.Effect<unknown, StdError.StdError>
  readonly references: (position: Position) => Effect.Effect<unknown, StdError.StdError>
  readonly implementation: (position: Position) => Effect.Effect<unknown, StdError.StdError>
  readonly documentSymbols: (path: string) => Effect.Effect<unknown, StdError.StdError>
  readonly workspaceSymbols: (query: string) => Effect.Effect<unknown, StdError.StdError>
  readonly prepareCallHierarchy: (position: Position) => Effect.Effect<unknown, StdError.StdError>
  readonly callHierarchyIncoming: (position: Position) => Effect.Effect<unknown, StdError.StdError>
  readonly callHierarchyOutgoing: (position: Position) => Effect.Effect<unknown, StdError.StdError>
  readonly diagnostics: (path: string) => Effect.Effect<unknown, StdError.StdError>
}
/** @category services @since 0.1.0 */
export const LanguageServer: Context.Service<LanguageServer, LanguageServer> = Context.Service(
  "/std/LanguageServer"
)
/** @category constructors @since 0.1.0 */
export const make = (service: LanguageServer): LanguageServer => LanguageServer.of(service)
const unsupported = (): Effect.Effect<never, StdError.StdError> =>
  Effect.fail(new StdError.StdError({ code: "unsupported", message: "Language server support is unavailable" }))
/** @category constructors @since 0.1.0 */
export const makeNoop = (): LanguageServer =>
  make({
    hover: unsupported,
    definition: unsupported,
    references: unsupported,
    implementation: unsupported,
    documentSymbols: unsupported,
    workspaceSymbols: unsupported,
    prepareCallHierarchy: unsupported,
    callHierarchyIncoming: unsupported,
    callHierarchyOutgoing: unsupported,
    diagnostics: unsupported
  })
/** @category layers @since 0.1.0 */
export const layerNoop: Layer.Layer<LanguageServer> = Layer.succeed(LanguageServer, makeNoop())
