import { Effect, Redacted as EffectRedacted } from "effect"
import { ModelError } from "./ModelError.ts"

/**
 * Credential-bearing field names shared by prepared-request validation and
 * executor diagnostics. Keep this matcher aligned across headers, query
 * parameters, and structured bodies so the sealed-step boundary and logging
 * boundary cannot disagree.
 *
 * @since 0.1.0
 * @category constants
 */
export const credentialNamePattern =
  /authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|secret|credential|password|passphrase|passwd|signature|x-amz-signature|cookie|set[-_]?cookie/i

/**
 * Reports whether a field name conventionally carries credentials.
 *
 * @since 0.1.0
 * @category predicates
 */
export const isCredentialName = (name: string): boolean => credentialNamePattern.test(name)

/**
 * A value whose normal string and JSON representations conceal its contents.
 *
 * @since 0.1.0
 * @category models
 */
export type Redacted<A = string> = EffectRedacted.Redacted<A>

/**
 * Per-request authentication applied after the secret-free prepared request
 * view has been created. This is the redaction boundary: credentials never
 * enter the harness step key, and signing never logs their values.
 *
 * OAuth is intentionally out of scope; the package README describes that
 * boundary.
 *
 * @since 0.1.0
 * @category models
 */
export interface Auth {
  readonly sign: (headers: Record<string, string>) => Effect.Effect<Record<string, string>, ModelError>
}

const secret = (key: Redacted<string>): Effect.Effect<string, ModelError> =>
  Effect.suspend(() => {
    const value = EffectRedacted.value(key)
    return value === ""
      ? Effect.fail(new ModelError({ code: "authentication", message: "API key must not be empty" }))
      : Effect.succeed(value)
  })

/**
 * Adds a redacted API key as an exact HTTP header.
 *
 * @since 0.1.0
 * @category constructors
 */
export const apiKeyHeader = (name: string, key: Redacted<string>): Auth => ({
  sign: Effect.fn("Auth.sign")((headers) => secret(key).pipe(Effect.map((value) => ({ ...headers, [name]: value }))))
})

/**
 * Adds a redacted API key using the HTTP bearer convention.
 *
 * @since 0.1.0
 * @category constructors
 */
export const bearer = (key: Redacted<string>): Auth => ({
  sign: Effect.fn("Auth.sign")((headers) =>
    secret(key).pipe(Effect.map((value) => ({ ...headers, Authorization: `Bearer ${value}` })))
  )
})
