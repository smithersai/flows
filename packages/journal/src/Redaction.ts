/**
 * Payload redaction for durable journal writes.
 *
 * The journal is permanent and broadly readable: every entry is replayed to
 * sync subscribers and to time-travel consumers. A secret that reaches
 * `payload_json` is therefore not a transient leak, so redaction happens once,
 * on the journal write path, rather than at each reader.
 *
 * Redaction is an **observability** concern and is confined to journal events
 * and export/display surfaces. It is deliberately not applied to executable
 * state — `flows_runs.state_json`, attempt checkpoints, errors, outcomes, and
 * cache results — because those are decoded and re-entered on resume: a
 * placeholder there resumes the flow with the wrong data, and replacing a
 * non-string value with a placeholder string makes the persisted state fail
 * schema decode outright, leaving the run undrivable (issue #72). A value
 * that must never reach durable executable state is a `Redacted` field in the
 * caller's own schema, not a name-suffix guess made at the storage seam.
 *
 * The rule set is adopted from smithers' `_traceRedaction` (its `case22`
 * secret-injection-no-leak fault case), which redacts both structurally — by
 * sensitive field name — and textually, by provider key and bearer-token
 * shape.
 *
 * @since 0.1.0
 */

/**
 * A textual redaction rule.
 *
 * `replace` is the substitution for a matched span; when omitted the whole
 * match is replaced by the placeholder.
 *
 * @since 0.1.0
 * @category models
 */
export interface Rule {
  readonly id: string
  readonly pattern: RegExp
  readonly replace?: string | undefined
}

/**
 * The placeholder written in place of a redacted value.
 *
 * @since 0.1.0
 * @category constants
 */
export const placeholder = "[REDACTED]"

/**
 * Textual rules covering the credential shapes flows actually carries:
 * provider API keys, bearer tokens, and `key=value` secret assignments.
 *
 * @since 0.1.0
 * @category constants
 */
export const defaultRules: ReadonlyArray<Rule> = [
  {
    id: "api-key",
    pattern: /\b(?:sk|pk)[-_][A-Za-z0-9][A-Za-z0-9_-]{7,}\b/g,
    replace: "[REDACTED_API_KEY]"
  },
  {
    id: "bearer-token",
    pattern: /Bearer\s+[A-Za-z0-9._-]{8,}/gi,
    replace: "Bearer [REDACTED_TOKEN]"
  },
  {
    id: "assignment",
    // Not `\b`: an underscore is a word character, so `\bapi` never fires
    // after `ANTHROPIC_`, which is exactly how env-style dumps leak.
    pattern: /(?<![A-Za-z0-9])(api[_-]?key|token|secret|password)=[^\s"']+/gi,
    replace: undefined
  }
]

const sensitiveKeySuffixes = ["authorization", "cookie", "apikey", "token", "password", "secret"]

/**
 * Whether a field name names a credential, ignoring case and separators, so
 * `api_key`, `apiKey`, and `x-api-key` are all recognised.
 *
 * @since 0.1.0
 * @category predicates
 */
export const isSensitiveKey = (key: string): boolean => {
  const canonical = key.toLowerCase().replace(/[^a-z0-9]/g, "")
  return sensitiveKeySuffixes.some((suffix) => canonical.endsWith(suffix))
}

const redactString = (value: string, rules: ReadonlyArray<Rule>): string =>
  rules.reduce(
    (text, rule) =>
      text.replace(rule.pattern, (match) =>
        rule.replace === undefined
          ? `${match.slice(0, match.indexOf("="))}=${placeholder}`
          : rule.replace),
    value
  )

/**
 * Options for {@link redact}.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options {
  readonly rules?: ReadonlyArray<Rule> | undefined
}

/**
 * Returns `value` with credentials removed.
 *
 * Objects and arrays are rebuilt: a field whose name {@link isSensitiveKey}
 * is replaced wholesale, every other string is run through the textual rules,
 * and a cycle is collapsed to `"[Circular]"` so the result always encodes.
 * Non-string leaves are returned untouched — redacting a number or a boolean
 * would destroy data without protecting anything.
 *
 * @since 0.1.0
 * @category redaction
 */
export const redact = (value: unknown, options?: Options): unknown => {
  const rules = options?.rules ?? defaultRules
  const walk = (node: unknown, ancestors: WeakSet<object>): unknown => {
    if (typeof node === "string") return redactString(node, rules)
    if (node === null || typeof node !== "object") return node
    if (ancestors.has(node)) return "[Circular]"
    ancestors.add(node)
    try {
      if (Array.isArray(node)) {
        return node.map((element) => walk(element, ancestors))
      }
      const result: Record<string, unknown> = {}
      for (const [key, field] of Object.entries(node as Record<string, unknown>)) {
        result[key] = isSensitiveKey(key) ? placeholder : walk(field, ancestors)
      }
      return result
    } finally {
      ancestors.delete(node)
    }
  }
  return walk(value, new WeakSet())
}

/**
 * A redaction function, as the journal consumes it.
 *
 * @since 0.1.0
 * @category models
 */
export type Redactor = (value: unknown) => unknown

/**
 * Builds a redactor over a rule set.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (options?: Options): Redactor => (value) => redact(value, options)

/**
 * Applies a redactor to an already-encoded JSON string, returning the
 * re-encoded result.
 *
 * For export and display surfaces that hold a column verbatim — a rendered
 * `state_json`, a support bundle — where the value is already encoded and must
 * not be decoded into the executable path. A string that does not parse is
 * returned untouched: validation is the caller's, and rejecting here would
 * turn a redaction concern into a schema error.
 *
 * @since 0.1.0
 * @category redaction
 */
export const redactJsonString = (json: string, redactor: Redactor): string => {
  try {
    const encoded = JSON.stringify(redactor(JSON.parse(json) as unknown))
    return encoded === undefined ? json : encoded
  } catch {
    return json
  }
}

/**
 * The identity redactor, for callers that persist payloads verbatim by
 * choice — a trusted single-tenant store, or a suite asserting on raw input.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeNoop = (): Redactor => (value) => value
