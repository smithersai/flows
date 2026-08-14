/**
 * Share capabilities: the authorization boundary of a shared branch.
 *
 * A share link carries a capability, not a session. The capability names
 * exactly one branch, one access level, and one expiry, and it is signed, so
 * the holder cannot widen it. Every branch operation authorizes through
 * `verify`, which is therefore the single place cross-branch access and
 * expired links are refused.
 *
 * The signature is HMAC-SHA-256 over a length-prefixed encoding of the claims.
 * Length prefixes matter: without them a branch id ending in the separator
 * could be re-cut into a different, still-validly-signed claim set. Web Crypto
 * is used directly so the same module runs in the browser and on node.
 *
 * @since 0.1.0
 */
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { Access, BranchId, ShareCapability, ShareClaims } from "./BranchProtocol.ts"
import { SyncError } from "./SyncError.ts"

/**
 * The branch and access one authorization request needs.
 *
 * @category models
 * @since 0.1.0
 */
export const AuthorizeRequest = Schema.Struct({ branchId: BranchId, access: Access })

/**
 * The branch and access one authorization request needs.
 *
 * @category models
 * @since 0.1.0
 */
export type AuthorizeRequest = typeof AuthorizeRequest.Type

/**
 * What a freshly minted capability grants.
 *
 * @category models
 * @since 0.1.0
 */
export const MintRequest = Schema.Struct({
  branchId: BranchId,
  capabilityId: Schema.NonEmptyString,
  access: Access,
  ttlMs: Schema.Int.check(Schema.isGreaterThan(0))
})

/**
 * What a freshly minted capability grants.
 *
 * @category models
 * @since 0.1.0
 */
export type MintRequest = typeof MintRequest.Type

/**
 * Share capability operations.
 *
 * `mint` fails with a `SyncError` when the Web Crypto signing operation
 * rejects; `verify` fails with a `SyncError` when signing rejects or the
 * capability is refused.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly mint: (request: MintRequest) => Effect.Effect<ShareCapability, SyncError>
  readonly verify: (
    capability: ShareCapability,
    request: AuthorizeRequest
  ) => Effect.Effect<ShareClaims, SyncError>
}

/**
 * The branch share-capability authority.
 *
 * @category services
 * @since 0.1.0
 */
export class BranchShare extends Context.Service<BranchShare, Service>()("@smthrs/sync-next/BranchShare") {}

/**
 * Constructs a share authority from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (implementation: Service): Service => BranchShare.of(implementation)

const denied = (message: string): SyncError => new SyncError({ code: "unauthorized", message })

/**
 * Constructs a share authority that mints nothing and trusts nothing.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  make({
    mint: () => Effect.die(denied("Branch sharing is unavailable")),
    verify: () => Effect.fail(denied("Branch sharing is unavailable")),
    ...overrides
  })

/**
 * Provides a share authority that refuses every capability.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<BranchShare> = Layer.succeed(BranchShare, makeNoop())

const encoder = new TextEncoder()

/** Length-prefixed so no two distinct claim sets share an encoding. */
const canonical = (claims: ShareClaims): string =>
  [claims.branchId, claims.capabilityId, claims.access, String(claims.issuedAtMs), String(claims.expiresAtMs)]
    .map((field) => `${field.length}:${field}`)
    .join("")

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

/** Length-independent comparison, so a signature check leaks no prefix length. */
const constantTimeEquals = (left: string, right: string): boolean => {
  let difference = left.length ^ right.length
  // `charCodeAt` past the end is NaN, and `NaN | 0` is 0, so the loop reads
  // both strings to the longer length without an early return.
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left.charCodeAt(index) | 0) ^ (right.charCodeAt(index) | 0)
  }
  return difference === 0
}

/**
 * Constructs the HMAC-SHA-256 share authority over a shared secret.
 *
 * Fails with a `SyncError` carrying the rejection as `cause` when Web Crypto
 * refuses to import the signing key.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeHmac = (options: { readonly secret: string }): Effect.Effect<Service, SyncError> =>
  Effect.map(
    Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey("raw", encoder.encode(options.secret), { name: "HMAC", hash: "SHA-256" }, false, [
          "sign"
        ]),
      catch: (cause) =>
        new SyncError({ code: "unknown", message: "Web Crypto could not import the HMAC signing key", cause })
    }),
    (key) => {
      const sign = (claims: ShareClaims): Effect.Effect<string, SyncError> =>
        Effect.map(
          Effect.tryPromise({
            try: () => crypto.subtle.sign("HMAC", key, encoder.encode(canonical(claims))),
            catch: (cause) =>
              new SyncError({ code: "unknown", message: "Web Crypto could not sign the share claims", cause })
          }),
          (signature) => hex(new Uint8Array(signature))
        )

      const mint = Effect.fn("BranchShare.mint")(function*(request: MintRequest) {
        yield* Effect.annotateCurrentSpan({ branchId: request.branchId, access: request.access })
        const issuedAtMs = yield* Clock.currentTimeMillis
        const claims = new ShareClaims({
          branchId: request.branchId,
          capabilityId: request.capabilityId,
          access: request.access,
          issuedAtMs,
          expiresAtMs: issuedAtMs + request.ttlMs
        })
        return new ShareCapability({ claims, signature: yield* sign(claims) })
      })

      const verify = Effect.fn("BranchShare.verify")(function*(
        capability: ShareCapability,
        request: AuthorizeRequest
      ) {
        yield* Effect.annotateCurrentSpan({ branchId: request.branchId, access: request.access })
        const claims = capability.claims
        const expected = yield* sign(claims)
        if (!constantTimeEquals(expected, capability.signature)) {
          return yield* Effect.fail(denied("The share capability signature is invalid"))
        }
        if (claims.branchId !== request.branchId) {
          return yield* Effect.fail(
            denied(`The share capability is scoped to branch ${claims.branchId}`)
          )
        }
        const nowMs = yield* Clock.currentTimeMillis
        if (nowMs >= claims.expiresAtMs) {
          return yield* Effect.fail(denied("The share capability has expired"))
        }
        if (request.access === "write" && claims.access !== "write") {
          return yield* Effect.fail(denied("The share capability is read-only"))
        }
        return claims
      })

      return make({ mint, verify })
    }
  )

/**
 * Provides the HMAC-SHA-256 share authority.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerHmac = (options: { readonly secret: string }): Layer.Layer<BranchShare, SyncError> =>
  Layer.effect(BranchShare, makeHmac(options))
