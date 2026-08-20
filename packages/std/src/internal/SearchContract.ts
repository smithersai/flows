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
  let inClass = false
  let classCharacters = 0
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]
    if (character === "\\") {
      const escaped = pattern[index + 1]
      if (escaped === undefined || /[A-Za-z0-9]/.test(escaped)) {
        return invalidPattern(pattern, "backreferences, shorthand classes and encoded escapes are not supported")
      }
      index++
      if (inClass) classCharacters++
      continue
    }
    if (character === "[" && inClass) {
      return invalidPattern(pattern, "nested and named character classes are not supported")
    }
    if (character === "[") {
      inClass = true
      classCharacters = 0
      continue
    }
    if (character === "]" && inClass) {
      if (classCharacters === 0 || (classCharacters === 1 && pattern[index - 1] === "^")) {
        return invalidPattern(pattern, "empty character classes are not supported")
      }
      inClass = false
      continue
    }
    if (inClass) {
      if ((character === "&" && pattern[index + 1] === "&") ||
        (character === "-" && pattern[index + 1] === "-") ||
        (character === "~" && pattern[index + 1] === "~")) {
        return invalidPattern(pattern, "character-class set operations are not supported")
      }
      classCharacters++
    }
  }
  try {
    new RegExp(pattern, "u")
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
export const expression = (pattern: string, fixedStrings: boolean, insensitive: boolean): RegExp => {
  const input = fixedStrings ? escapeRegex(pattern) : pattern
  let source = ""
  let inClass = false
  for (let index = 0; index < input.length; index++) {
    const character = input[index]
    if (character === "\\") {
      source += `${character}${input[index + 1] ?? ""}`
      index++
    } else if (character === "[") {
      inClass = true
      source += character
    } else if (character === "]" && inClass) {
      inClass = false
      source += character
    } else if (!inClass && character === ".") {
      source += "[^\\n]"
    } else if (!inClass && character === "$") {
      source += "(?![\\s\\S])"
    } else {
      source += character
    }
  }
  return new RegExp(source, insensitive ? "iu" : "u")
}

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
    if (
      character === "*" && next === "*" &&
      (index === 0 || pattern[index - 1] === "/") &&
      (pattern[index + 2] === undefined || pattern[index + 2] === "/")
    ) {
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
 * Validates the portable `-g` grammar before either peer sees it.
 *
 * @private
 * @since 0.1.0
 */
export const validateGlob = (glob: string): StdError.StdError | undefined => {
  const pattern = glob.startsWith("!") ? glob.slice(1) : glob
  if (!/^[\x20-\x7e]*$/.test(pattern)) return invalidPattern(glob, "globs must contain printable ASCII only")
  if (pattern.includes("\\") || pattern.includes("[") || pattern.includes("]")) {
    return invalidPattern(glob, "glob escapes and character classes are not supported")
  }
  let inBrace = false
  let alternatives = 1
  let expansionCount = 1
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]
    if (character === "{") {
      if (inBrace) return invalidPattern(glob, "nested brace alternatives are not supported")
      inBrace = true
      alternatives = 1
    } else if (character === "," && inBrace) {
      alternatives++
    } else if (character === "}") {
      if (!inBrace || alternatives < 2) return invalidPattern(glob, "braces must contain alternatives")
      inBrace = false
      expansionCount *= alternatives
      if (expansionCount > 256) return invalidPattern(glob, "glob brace expansion exceeds 256 patterns")
    }
  }
  if (inBrace) return invalidPattern(glob, "glob braces must be balanced")
  return undefined
}

/**
 * Applies ripgrep `-g` ordering: positive globs include and `!` globs exclude.
 *
 * @private
 * @since 0.1.0
 */
export const includedByGlobs = (globs: ReadonlyArray<string>, relative: string, basename: string): boolean => {
  const positives = globs.filter((glob) => !glob.startsWith("!"))
  let included = positives.length === 0
  for (const glob of globs) {
    const excluded = glob.startsWith("!")
    if (matchesGlob(excluded ? glob.slice(1) : glob, relative, basename)) included = !excluded
  }
  return included
}
