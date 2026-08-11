import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"

/** Runs a test Effect with the concrete Node crypto layer. */
export const runPromise = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, NodeCrypto.layer))

/** Runs a test Effect that is expected to fail, returning the typed error. */
export const runFailure = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>): Promise<E> =>
  runPromise(Effect.flip(effect))
