/**
 * The source of the fencing identity a store incarnation runs under.
 *
 * Minting an {@link OwnerId} is an act of nondeterminism against the host: it
 * reads a process identifier and draws a fresh nonce. Both belong behind a
 * port rather than in the composition itself — the closed-host doctrine in
 * `@smthrs/kernel`'s `HostServices` admits no ambient `process` and no static
 * `node:crypto` import, and browser support is a hard requirement, so a store
 * that reached for either directly could not be composed in a tab at all.
 *
 * Governing design: `docs/specs/Concepts/Run Ownership.md`.
 *
 * @since 0.1.0
 */
import { OwnerId } from "@smthrs/journal/OwnerId"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Random from "effect/Random"

/**
 * Owner identity operations.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  /**
   * Mints the identity this incarnation fences its durable writes with. The
   * host supplies the incarnation; the caller supplies the host id, because
   * which host a store speaks for is a composition decision, not a host fact.
   */
  readonly ownerId: (hostId: string) => Effect.Effect<OwnerId>
}

/**
 * Service tag for the owner identity source.
 *
 * @category services
 * @since 0.1.0
 */
export class OwnerIdentity extends Context.Service<OwnerIdentity, Service>()("flows/engine-store/OwnerIdentity") {}

/**
 * Constructs an owner identity source from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (service: Service): Service => OwnerIdentity.of(service)

/**
 * The host's process identifier, when the platform has one.
 *
 * Read off `globalThis` rather than through a bare `process` reference so the
 * module carries no Node binding at all: a browser bundle sees `undefined`
 * here and falls through to a drawn incarnation number below. This is the one
 * place in the package that looks at the platform, which is exactly what makes
 * it replaceable — a host that knows better provides its own {@link Service}.
 */
const hostProcessId = (globalThis as { readonly process?: { readonly pid?: number } }).process?.pid

/**
 * The incarnation number component of an owner id.
 *
 * On node and bun this is the real pid, unchanged from what the store minted
 * before this service existed. A browser tab has no process, and no stable
 * per-tab integer that means the same thing, so a drawn number stands in: the
 * component's only job is to distinguish concurrent incarnations on one host,
 * and `Random` is the sanctioned port for drawing one. Effect's own cluster
 * storage does the same where a backend exposes no connection pid
 * (`reference/effect` `unstable/cluster/SqlRunnerStorage.ts`).
 */
const incarnationId: Effect.Effect<number> = typeof hostProcessId === "number"
  ? Effect.succeed(hostProcessId)
  : Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER, { halfOpen: true })

/**
 * The default identity source: the platform's process id where one exists,
 * paired with a fresh Web Crypto UUID nonce. `crypto.randomUUID` is the same
 * generator the previous `node:crypto` import reached, and is a global on
 * node, bun, and in a secure browser context, so the default behaves
 * identically on every supported host without binding one of them.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeDefault = (): Service =>
  make({
    ownerId: Effect.fn("OwnerIdentity.ownerId")(function*(hostId) {
      return {
        hostId,
        pid: yield* incarnationId,
        nonce: crypto.randomUUID()
      } satisfies OwnerId
    })
  })

/**
 * Provides {@link makeDefault}. This is what engine composition supplies
 * unless a host has a better answer.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<OwnerIdentity> = Layer.sync(OwnerIdentity)(makeDefault)

/**
 * Provides a fixed identity. A test — or a host that derives ownership from
 * something outside this process, such as a lease it already holds — pins the
 * whole token instead of letting the default draw one.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerConstant = (owner: OwnerId): Layer.Layer<OwnerIdentity> =>
  Layer.succeed(OwnerIdentity)(make({ ownerId: () => Effect.succeed(owner) }))
