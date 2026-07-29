/**
 * The workspace root used to make filesystem capability resources stable.
 *
 * This local service should migrate to `@flows/host` once that package owns a
 * workspace-root contract.
 *
 * Governing design:
 * `docs/specs/Concepts/Effect Taxonomy.md` and
 * `docs/specs/Concepts/Permission Kernel.md`.
 *
 * @since 0.1.0
 */
import { Context, Layer } from "effect"

/**
 * Workspace-root configuration.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly root: string
}

/**
 * The workspace-root service tag.
 *
 * @category services
 * @since 0.1.0
 */
export class Workspace extends Context.Service<Workspace, Service>()("@flows/kernel/Workspace") {}

/**
 * Constructs workspace-root configuration.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (root: string): Service => Workspace.of({ root })

/**
 * Provides a workspace root.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (root: string): Layer.Layer<Workspace> => Layer.succeed(Workspace, make(root))

/**
 * Constructs a relative workspace-root stub for tests.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop: Service = make(".")

/**
 * Provides a relative workspace-root stub for tests.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<Workspace> = Layer.succeed(Workspace, makeNoop)
