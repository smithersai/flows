/**
 * Deterministic serialization for step-key material.
 *
 * @since 0.1.0
 */
import * as Result from "effect/Result"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"

/**
 * The discriminator prepended to every canonical payload.
 *
 * @since 0.1.0
 * @category constants
 */
export const format = "flows-step-key-v1"

/**
 * Stable reasons canonical serialization can reject a value.
 *
 * @since 0.1.0
 * @category models
 */
export type CanonicalErrorCode =
  | "unsupported_type"
  | "non_finite_number"
  | "sparse_array"
  | "class_instance"
  | "cycle"
  | "redacted"

/**
 * A value cannot safely participate in a canonical step key.
 *
 * @since 0.1.0
 * @category errors
 */
export class CanonicalError extends Schema.TaggedErrorClass<CanonicalError>()("@flows/keys/CanonicalError", {
  code: Schema.Literals([
    "unsupported_type",
    "non_finite_number",
    "sparse_array",
    "class_instance",
    "cycle",
    "redacted"
  ]),
  path: Schema.String,
  message: Schema.String
}) {}

const fail = (code: CanonicalErrorCode, path: string, message: string): never => {
  throw new CanonicalError({ code, path, message })
}

const serializeString = (value: string): string => {
  const normalized = value.normalize("NFC")
  return `s${normalized.length}:${normalized}`
}

const serializeNumber = (value: number, path: string): string => {
  if (!Number.isFinite(value)) {
    return fail("non_finite_number", path, "Canonical numbers must be finite")
  }
  return `d${Object.is(value, -0) ? "0" : value.toString()};`
}

const isPlainObject = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const serializeValue = (value: unknown, path: string, ancestors: Set<object>): string => {
  switch (typeof value) {
    case "string":
      return serializeString(value)
    case "number":
      return serializeNumber(value, path)
    case "boolean":
      return value ? "b1;" : "b0;"
    case "undefined":
    case "bigint":
    case "symbol":
    case "function":
      return fail("unsupported_type", path, `Unsupported canonical type: ${typeof value}`)
    case "object": {
      if (value === null) return "n;"
      if (Redacted.isRedacted(value)) {
        return fail("redacted", path, "Redacted values must not participate in step keys")
      }
      if (ancestors.has(value)) return fail("cycle", path, "Canonical values must not contain cycles")
      ancestors.add(value)
      try {
        if (Array.isArray(value)) {
          for (let index = 0; index < value.length; index++) {
            if (!(index in value)) return fail("sparse_array", `${path}[${index}]`, "Sparse arrays are not canonical")
          }
          return `a${value.length}:[${
            value.map((item, index) => serializeValue(item, `${path}[${index}]`, ancestors)).join("")
          }]`
        }
        if (!isPlainObject(value)) {
          return fail("class_instance", path, "Only object literals may participate in step keys")
        }
        if (Object.getOwnPropertySymbols(value).length > 0) {
          return fail("unsupported_type", path, "Symbol-keyed properties are not canonical")
        }
        const keys = Object.keys(value).sort()
        const fields = keys.map((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, key)
          if (descriptor === undefined || !("value" in descriptor)) {
            return fail("unsupported_type", `${path}.${key}`, "Accessor properties are not canonical")
          }
          return `${serializeString(key)}${serializeValue(descriptor.value, `${path}.${key}`, ancestors)}`
        })
        return `o${keys.length}:{${fields.join("")}}`
      } finally {
        ancestors.delete(value)
      }
    }
  }
}

/**
 * Serializes JSON-like data into the versioned, type-tagged flows key format.
 * Object keys sort by UTF-16 code-unit order; strings normalize to NFC; arrays
 * retain their declared order. The result begins with the format discriminator.
 *
 * @since 0.1.0
 * @category serialization
 */
export const serialize = (value: unknown): Result.Result<string, CanonicalError> =>
  Result.try({
    try: () => `${format}|${serializeValue(value, "$", new Set())}`,
    catch: (cause) =>
      cause instanceof CanonicalError
        ? cause
        : new CanonicalError({
          code: "unsupported_type",
          path: "$",
          message: "Canonical serialization failed"
        })
  })
