/**
 * Inert remote-cache configuration for a workspace root BUILD.ts file.
 *
 * @since 0.1.0
 */
import * as NodeUtil from "node:util/types"

/**
 * Runtime marker for a remote-cache declaration.
 *
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("tsflows-rules/RemoteCache") as never

/**
 * Environment variable read for the bearer token when none is declared.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultTokenEnv = "TSFLOWS_CACHE_TOKEN"

/**
 * A pure remote-cache declaration.
 *
 * The declaration carries only the HTTPS endpoint and the name of the
 * environment variable holding its bearer token. The token value remains
 * host state and is never part of BUILD.ts or target key material.
 *
 * @category models
 * @since 0.1.0
 */
export interface RemoteCache {
  readonly [TypeId]: typeof TypeId
  readonly endpoint: string
  readonly tokenEnv: string
}

/**
 * Options accepted by {@link make}.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  readonly endpoint: string
  readonly tokenEnv?: string | undefined
}

const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Validates and normalizes a remote-cache endpoint.
 *
 * @category validation
 * @since 0.1.0
 */
export const normalizeEndpoint = (value: string): string => {
  if (typeof value !== "string") throw new TypeError("remote cache endpoint must be a string")
  const trimmed = value.trim()
  let endpoint: URL
  try {
    endpoint = new URL(trimmed)
  } catch {
    throw new Error(`remote cache endpoint must be an absolute HTTPS URL: ${value}`)
  }
  if (endpoint.protocol !== "https:") {
    throw new Error(`remote cache endpoint must use HTTPS: ${value}`)
  }
  if (endpoint.username !== "" || endpoint.password !== "") {
    throw new Error("remote cache endpoint must not contain credentials")
  }
  if (endpoint.search !== "" || endpoint.hash !== "") {
    throw new Error("remote cache endpoint must not contain a query or fragment")
  }
  return endpoint.href.replace(/\/$/, "")
}

/**
 * Validates one bearer-token environment variable name.
 *
 * @category validation
 * @since 0.1.0
 */
export const normalizeTokenEnv = (value: string): string => {
  if (typeof value !== "string") throw new TypeError("remote cache tokenEnv must be a string")
  const trimmed = value.trim()
  if (!environmentName.test(trimmed)) {
    throw new Error(`remote cache tokenEnv must be an environment variable name: ${value}`)
  }
  if (trimmed === "TSFLOWS_CACHE_URL") {
    throw new Error("remote cache tokenEnv must not be TSFLOWS_CACHE_URL")
  }
  return trimmed
}

/**
 * Creates a pure remote-cache declaration.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: Options): RemoteCache => {
  if (
    typeof options !== "object" || options === null || NodeUtil.isProxy(options) ||
    (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)
  ) throw new TypeError("RemoteCache options must be a plain object")
  if (Object.getOwnPropertySymbols(options).length > 0) {
    throw new TypeError("RemoteCache options must not contain symbol properties")
  }
  const names = Object.getOwnPropertyNames(options)
  for (const name of names) {
    if (name !== "endpoint" && name !== "tokenEnv") {
      throw new TypeError(`RemoteCache received unknown option ${JSON.stringify(name)}`)
    }
  }
  const read = (name: "endpoint" | "tokenEnv"): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(options, name)
    if (descriptor === undefined) return undefined
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`RemoteCache option ${name} must be an enumerable data property`)
    }
    return descriptor.value
  }
  const endpoint = read("endpoint")
  const tokenEnv = read("tokenEnv")
  if (typeof endpoint !== "string") throw new TypeError("RemoteCache option endpoint must be a string")
  if (tokenEnv !== undefined && typeof tokenEnv !== "string") {
    throw new TypeError("RemoteCache option tokenEnv must be a string")
  }
  return Object.freeze<RemoteCache>({
    [TypeId]: TypeId,
    endpoint: normalizeEndpoint(endpoint),
    tokenEnv: normalizeTokenEnv(tokenEnv ?? defaultTokenEnv)
  })
}

/**
 * Checks whether a BUILD.ts export is a remote-cache declaration.
 *
 * @category guards
 * @since 0.1.0
 */
export const isRemoteCache = (value: unknown): value is RemoteCache => {
  if (typeof value !== "object" || value === null || NodeUtil.isProxy(value)) return false
  const own = (key: PropertyKey): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
  }
  return own(TypeId) === TypeId &&
    typeof own("endpoint") === "string" &&
    typeof own("tokenEnv") === "string"
}
