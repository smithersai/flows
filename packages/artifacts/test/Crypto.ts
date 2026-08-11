import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Sha256 } from "@smthrs/crypto"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const encoder = new TextEncoder()

/** Hashes test fixtures with the concrete Node crypto layer. */
export const sha256 = (input: string | Uint8Array): string =>
  Effect.runSync(
    Schema.decodeUnknownEffect(Sha256)(input).pipe(Effect.provide(NodeCrypto.layer), Effect.orDie)
  )

/** Runs a test Effect with the concrete Node crypto layer. */
export const runPromise = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, NodeCrypto.layer))

/** UTF-8 bytes, the shape every artifact fixture is written in. */
export const bytes = (text: string): Uint8Array => encoder.encode(text)

/** Decodes stored artifact bytes back to text for assertions. */
export const text = (input: Uint8Array | undefined): string | undefined =>
  input === undefined ? undefined : new TextDecoder().decode(input)
