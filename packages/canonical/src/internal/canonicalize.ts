/**
 * RFC 8785 (JSON Canonicalization Scheme) serialization.
 *
 * Inlined replacement for the `canonicalize` npm package: that library ships
 * ESM-only `exports`, so the CJS build produced for release artifacts could
 * never `require` it. The algorithm is small enough to own — member keys are
 * sorted by UTF-16 code units and numbers use ECMAScript's `JSON.stringify`
 * serialization, both exactly as RFC 8785 specifies.
 *
 * @since 0.1.0
 */

const hasToJson = (value: object): value is { toJSON: () => unknown } =>
  "toJSON" in value && typeof (value as { toJSON: unknown }).toJSON === "function"

const serialize = (value: unknown, ancestors: WeakSet<object>): string | undefined => {
  if (typeof value === "number" && Number.isNaN(value)) {
    throw new TypeError("NaN is not allowed")
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("Infinity is not allowed")
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }
  if (ancestors.has(value)) {
    throw new TypeError("Circular reference detected")
  }
  ancestors.add(value)
  try {
    if (hasToJson(value)) {
      return serialize(value.toJSON(), ancestors)
    }
    if (Array.isArray(value)) {
      const items = value.map((item) =>
        item === undefined || typeof item === "symbol" ? "null" : serialize(item, ancestors)
      )
      return `[${items.join(",")}]`
    }
    const record = value as Record<string, unknown>
    const members = Object.keys(record).sort().flatMap((key) => {
      const member = record[key]
      if (member === undefined || typeof member === "symbol") {
        return []
      }
      return [`${JSON.stringify(key)}:${serialize(member, ancestors)}`]
    })
    return `{${members.join(",")}}`
  } finally {
    ancestors.delete(value)
  }
}

/**
 * Serializes a JSON value into its RFC 8785 canonical form.
 *
 * Returns `undefined` when the top-level value has no JSON representation
 * (`undefined`, a symbol, or a function), mirroring `JSON.stringify`.
 * Throws on non-finite numbers and circular references, which RFC 8785
 * cannot represent.
 *
 * @since 0.1.0
 */
export const canonicalize = (value: unknown): string | undefined => serialize(value, new WeakSet())
