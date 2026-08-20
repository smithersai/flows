/**
 * Shared validation and matching rules for the ripgrep contract.
 *
 * @since 0.1.0
 */
import * as StdError from "../StdError.ts"

/**
 * Constructs the common unsupported-pattern failure.
 *
 * @private
 * @since 0.1.0
 */
export const invalidPattern = (pattern: string, detail: string): StdError.StdError =>
  new StdError.StdError({ code: "invalid_pattern", message: `Unsupported ripgrep pattern "${pattern}": ${detail}` })

/**
 * Constructs the common invalid-options failure.
 *
 * @private
 * @since 0.1.0
 */
export const invalidInput = (detail: string): StdError.StdError =>
  new StdError.StdError({ code: "invalid_input", message: `Invalid ripgrep options: ${detail}` })

/**
 * Constructs the common missing-root failure.
 *
 * @private
 * @since 0.1.0
 */
export const notFound = (path: string): StdError.StdError =>
  new StdError.StdError({ code: "not_found", message: `Path not found: ${path}`, path })

/**
 * Validates Flows Ripgrep ASCII v1. It is deliberately the intersection of
 * Rust regex and JavaScript RegExp: ASCII patterns, captures, alternation,
 * ASCII character classes and ordinary quantifiers. Lookaround,
 * backreferences, named/inline groups, Unicode/shorthand classes and control
 * escapes are rejected before either implementation runs.
 *
 * @private
 * @since 0.1.0
 */
export const validatePattern = (pattern: string, fixedStrings: boolean): StdError.StdError | undefined => {
  if (!/^[\x20-\x7e]*$/.test(pattern)) return invalidPattern(pattern, "patterns must contain printable ASCII only")
  if (fixedStrings) return undefined
  if (pattern.includes("(?")) return invalidPattern(pattern, "special groups and lookaround are not supported")
  if (/\\(?:[1-9]|[bBdDsSwWpPkKxXupPcC])/.test(pattern)) {
    return invalidPattern(pattern, "backreferences, shorthand classes and encoded escapes are not supported")
  }
  try {
    new RegExp(pattern)
    return undefined
  } catch {
    return invalidPattern(pattern, "invalid Flows Ripgrep ASCII v1 expression")
  }
}

/**
 * Escapes literal text for JavaScript regular expressions.
 *
 * @private
 * @since 0.1.0
 */
export const escapeRegex = (value: string): string => value.replace(/[.*+^${}()|[\]\\]/g, "\\$&")

/**
 * Compiles a pattern after common validation.
 *
 * @private
 * @since 0.1.0
 */
export const expression = (pattern: string, fixedStrings: boolean, insensitive: boolean): RegExp =>
  new RegExp(fixedStrings ? escapeRegex(pattern) : pattern, insensitive ? "i" : "")

const expandBraces = (pattern: string): ReadonlyArray<string> => {
  const opening = pattern.indexOf("{")
  if (opening < 0) return [pattern]
  const closing = pattern.indexOf("}", opening + 1)
  if (closing < 0) return [pattern]
  const alternatives = pattern.slice(opening + 1, closing).split(",")
  if (alternatives.length < 2) return [pattern]
  return alternatives.flatMap((alternative) =>
    expandBraces(
      `${pattern.slice(0, opening)}${alternative}${pattern.slice(closing + 1)}`
    )
  )
}

const globExpression = (pattern: string): RegExp => {
  let source = ""
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]
    const next = pattern[index + 1]
    if (character === "*" && next === "*") {
      source += pattern[index + 2] === "/" ? "(?:.*/)?" : ".*"
      index += pattern[index + 2] === "/" ? 2 : 1
    } else if (character === "*") source += "[^/]*"
    else if (character === "?") source += "[^/]"
    else source += character?.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&") ?? ""
  }
  return new RegExp(`^${source}$`)
}

/**
 * Matches the supported `-g` subset. A pattern without `/` matches any basename.
 *
 * @private
 * @since 0.1.0
 */
export const matchesGlob = (pattern: string, relative: string, basename: string): boolean =>
  expandBraces(pattern).some((expanded) => globExpression(expanded).test(expanded.includes("/") ? relative : basename))

/**
 * Applies ripgrep `-g` ordering: positive globs include and `!` globs exclude.
 *
 * @private
 * @since 0.1.0
 */
export const includedByGlobs = (globs: ReadonlyArray<string>, relative: string, basename: string): boolean => {
  const positives = globs.filter((glob) => !glob.startsWith("!"))
  if (positives.length > 0 && !positives.some((glob) => matchesGlob(glob, relative, basename))) return false
  return !globs.some((glob) => glob.startsWith("!") && matchesGlob(glob.slice(1), relative, basename))
}
