/**
 * Import scanning, specifier resolution, and the visibility decision the
 * planner enforces.
 *
 * `Visibility` in `@smthrs/targets` only constructs declarations. Deciding
 * whether one target may depend on another needs three things that module
 * deliberately does not have: the imports a source file writes, the target
 * label an import specifier lands on, and the package manifests a
 * `Visibility.group` predicate reads. This module supplies all three.
 *
 * Nothing here touches the filesystem. Every function takes the workspace
 * facts it needs as arguments, so the same code answers in a browser host that
 * supplies a file index through a layer, and so the decision is testable
 * without a scratch workspace.
 *
 * The repository has no import graph to reuse. Each of the 45 packages carries
 * its own copy of `scripts/circular.mjs`, and each runs madge over that one
 * package's `src` with `skipTypeImports: true`. There is no cross-package edge
 * and no mapping from an import specifier to a target label. This
 * scanner covers type-only imports, because a type import is still a
 * compile-time dependency on another package's source and is exactly the edge
 * a visibility declaration exists to refuse.
 *
 * @since 0.1.0
 */
import type * as Visibility from "@smthrs/targets/Visibility"

/**
 * One import an ECMAScript or TypeScript source file writes.
 *
 * `line` is 1-based and names the line the specifier appears on, so a refusal
 * points at an editable position.
 *
 * @category models
 * @since 0.1.0
 */
export interface Import {
  readonly specifier: string
  readonly typeOnly: boolean
  readonly line: number
}

/**
 * File extensions the scanner reads.
 *
 * @category models
 * @since 0.1.0
 */
export const sourceExtensions: ReadonlyArray<string> = Object.freeze([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs"
])

/**
 * Whether a workspace path names a file this module can scan.
 *
 * A declaration file is scanned like any other source: `import type` in a
 * `.d.ts` is a dependency edge.
 *
 * @category guards
 * @since 0.1.0
 */
export const isSource = (path: string): boolean => sourceExtensions.some((extension) => path.endsWith(extension))

/** Characters that end a line for the purpose of a line comment. */
const isLineBreak = (character: string): boolean =>
  character === "\n" || character === "\r" || character === "\u2028" || character === "\u2029"

/**
 * Replaces every comment and string body with spaces, keeping offsets.
 *
 * Blanking rather than deleting keeps one offset space for the whole scan, so
 * a literal's recorded position still indexes the cleaned text and the text
 * before it is the code that introduced it.
 */
const blank = (text: string): { readonly cleaned: string; readonly literals: ReadonlyArray<Literal> } => {
  const out = new Array<string>(text.length)
  const literals: Array<Literal> = []
  let index = 0
  while (index < text.length) {
    const character = text[index]!
    const next = text[index + 1]
    if (character === "/" && next === "/") {
      while (index < text.length && !isLineBreak(text[index]!)) out[index++] = " "
      continue
    }
    if (character === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2)
      const stop = end < 0 ? text.length : end + 2
      while (index < stop) {
        const inner = text[index]!
        out[index] = isLineBreak(inner) ? inner : " "
        index += 1
      }
      continue
    }
    if (character === "\"" || character === "'") {
      const start = index
      out[index++] = character
      let value = ""
      let closed = false
      while (index < text.length) {
        const inner = text[index]!
        out[index] = inner === character ? inner : " "
        index += 1
        if (inner === "\\") {
          if (index < text.length) out[index++] = " "
          value = ""
          continue
        }
        if (inner === character) {
          closed = true
          break
        }
        if (isLineBreak(inner)) break
        value += inner
      }
      if (closed) literals.push({ value, start })
      continue
    }
    if (character === "`") {
      out[index++] = " "
      while (index < text.length) {
        const inner = text[index]!
        out[index++] = isLineBreak(inner) ? inner : " "
        if (inner === "\\") {
          if (index < text.length) out[index++] = " "
          continue
        }
        if (inner === "`") break
      }
      continue
    }
    out[index] = character
    index += 1
  }
  return { cleaned: out.join(""), literals }
}

interface Literal {
  readonly value: string
  readonly start: number
}

/** How far back a specifier's introducing keyword may be. */
const lookBehind = 512

/**
 * Reads every import specifier a source file names.
 *
 * The scan blanks comments and string bodies first, so a specifier written
 * inside a comment or another string is never reported. It then classifies
 * each surviving literal by the code immediately before it: `from`, a bare
 * `import`, a dynamic `import(`, or a `require(`. A specifier built from a
 * template literal or a variable is not statically resolvable and is not
 * reported.
 *
 * @category scanning
 * @since 0.1.0
 */
export const scan = (text: string): ReadonlyArray<Import> => {
  const { cleaned, literals } = blank(text)
  const found: Array<Import> = []
  for (const literal of literals) {
    const tail = cleaned.slice(Math.max(0, literal.start - lookBehind), literal.start)
    const clause = /(?:^|[^\w$.])(import|export)\s*$/.exec(tail)
    const from = /(?:^|[^\w$.])from\s*$/.test(tail)
    const call = /(?:^|[^\w$.])(import|require)\s*\(\s*$/.exec(tail)
    if (clause === null && !from && call === null) continue
    // A specifier that carried an escape is blanked to the empty string by
    // `blank`, so it never resolves to a path and never refuses an edge.
    if (literal.value === "") continue
    found.push({
      specifier: literal.value,
      typeOnly: from ? isTypeClause(tail) : false,
      line: 1 + (text.slice(0, literal.start).match(/\n/g)?.length ?? 0)
    })
  }
  return found
}

/** Whether the `import` or `export` clause before a `from` was type-only. */
const isTypeClause = (tail: string): boolean => {
  const matches = [...tail.matchAll(/(?:^|[^\w$.])(import|export)\b/g)]
  const last = matches.at(-1)
  if (last === undefined) return false
  const after = tail.slice(last.index + last[0].length)
  return /^\s*type\b/.test(after)
}

/**
 * The npm package name and subpath a bare specifier names.
 *
 * Returns undefined for a relative specifier, an absolute one, a `node:`
 * builtin, and a `#` subpath import, none of which can name a workspace
 * package.
 *
 * @category resolution
 * @since 0.1.0
 */
export const parseBare = (specifier: string): { readonly name: string; readonly subpath: string } | undefined => {
  if (specifier === "" || specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#")) {
    return undefined
  }
  if (specifier.includes(":")) return undefined
  const segments = specifier.split("/")
  const scoped = specifier.startsWith("@")
  if (scoped && segments.length < 2) return undefined
  const name = scoped ? segments.slice(0, 2).join("/") : segments[0]!
  const rest = segments.slice(scoped ? 2 : 1)
  return { name, subpath: rest.length === 0 ? "." : `./${rest.join("/")}` }
}

/**
 * Normalizes a workspace-relative path, refusing one that escapes the root.
 *
 * @category resolution
 * @since 0.1.0
 */
export const normalize = (path: string): string | undefined => {
  const segments: Array<string> = []
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      if (segments.pop() === undefined) return undefined
      continue
    }
    segments.push(segment)
  }
  return segments.join("/")
}

/**
 * Every path an unextended specifier may resolve to, in preference order.
 *
 * TypeScript's NodeNext resolution reads `./x.js` from `./x.ts`, and this
 * workspace also writes `./x.ts` directly. Both spellings resolve here, so a
 * visibility refusal does not depend on which one an author chose.
 *
 * @category resolution
 * @since 0.1.0
 */
export const candidates = (path: string): ReadonlyArray<string> => {
  const rewrites: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
    [".js", [".ts", ".tsx", ".d.ts"]],
    [".mjs", [".mts", ".d.mts"]],
    [".cjs", [".cts", ".d.cts"]],
    [".jsx", [".tsx"]]
  ]
  const list = [path]
  for (const [extension, replacements] of rewrites) {
    if (!path.endsWith(extension)) continue
    for (const replacement of replacements) list.push(`${path.slice(0, -extension.length)}${replacement}`)
  }
  for (const extension of [...sourceExtensions, ".d.ts", ".json"]) list.push(`${path}${extension}`)
  for (const index of ["index.ts", "index.tsx", "index.mts", "index.js", "index.mjs"]) list.push(`${path}/${index}`)
  return list
}

/**
 * Resolves a relative specifier against the file that wrote it.
 *
 * @category resolution
 * @since 0.1.0
 */
export const resolveRelative = (
  importer: string,
  specifier: string,
  exists: (path: string) => boolean
): string | undefined => {
  const directory = importer.includes("/") ? importer.slice(0, importer.lastIndexOf("/")) : ""
  const joined = normalize(directory === "" ? specifier : `${directory}/${specifier}`)
  if (joined === undefined || joined === "") return undefined
  return candidates(joined).find((candidate) => exists(candidate))
}

/**
 * Resolves one subpath through a manifest `exports` field.
 *
 * The subset implemented is what a workspace package needs: a string value, a
 * conditions object, a subpath map, one `*` wildcard per key, and `null` for a
 * blocked subpath. One key answers, chosen the way Node chooses it: an exact
 * match, otherwise the wildcard key with the longest static prefix. Every
 * string that key reaches is returned, because a package that maps one subpath
 * to a source file under one condition and a built file under another still
 * names one file in the source tree.
 *
 * @category resolution
 * @since 0.1.0
 */
export const exportTargets = (exports: unknown, subpath: string): ReadonlyArray<string> => {
  const found: Array<string> = []
  const collect = (value: unknown): void => {
    if (typeof value === "string") {
      const normalized = normalize(value)
      if (normalized !== undefined && normalized !== "") found.push(normalized)
      return
    }
    if (Array.isArray(value)) {
      for (const entry of value) collect(entry)
      return
    }
    if (typeof value !== "object" || value === null) return
    for (const entry of Object.values(value)) collect(entry)
  }
  if (typeof exports === "string") {
    if (subpath === ".") collect(exports)
    return found
  }
  if (typeof exports !== "object" || exports === null || Array.isArray(exports)) return found
  const entries = Object.entries(exports)
  const isSubpathMap = entries.some(([key]) => key === "." || key.startsWith("./"))
  if (!isSubpathMap) {
    if (subpath === ".") collect(exports)
    return found
  }
  // Node picks one key: an exact match, otherwise the wildcard key with the
  // longest static prefix. Only that key answers, so a `null` on a specific
  // key blocks a subpath a broader wildcard would otherwise expose.
  const exact = entries.find(([key]) => key === subpath)
  if (exact !== undefined) {
    collect(exact[1])
    return found
  }
  let best: { readonly prefix: string; readonly suffix: string; readonly value: unknown } | undefined
  for (const [key, value] of entries) {
    const star = key.indexOf("*")
    if (star < 0) continue
    const prefix = key.slice(0, star)
    const suffix = key.slice(star + 1)
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue
    if (subpath.length < prefix.length + suffix.length) continue
    if (
      best === undefined ||
      prefix.length > best.prefix.length ||
      (prefix.length === best.prefix.length && suffix.length > best.suffix.length)
    ) best = { prefix, suffix, value }
  }
  if (best === undefined) return found
  const filled = subpath.slice(best.prefix.length, subpath.length - best.suffix.length)
  const substituted: Array<string> = []
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      substituted.push(value.split("*").join(filled))
      return
    }
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry)
      return
    }
    if (typeof value !== "object" || value === null) return
    for (const entry of Object.values(value)) walk(entry)
  }
  walk(best.value)
  for (const path of substituted) collect(path)
  return found
}

/**
 * The target on the importing side of an edge.
 *
 * `directory` is the label's package path, the directory the BUILD.ts that
 * declares the target sits in. `packageDirectory` is the enclosing npm
 * package, which is the same directory for a package-level target and an
 * ancestor for a folder unit. `manifest` is that package's manifest, which
 * only a {@link Visibility.Group} predicate reads.
 *
 * @category models
 * @since 0.1.0
 */
export interface Consumer {
  readonly label: string
  readonly directory: string
  readonly packageDirectory: string
  readonly manifest: Visibility.PackageManifest | undefined
}

/**
 * The target on the imported side of an edge.
 *
 * @category models
 * @since 0.1.0
 */
export interface Producer {
  readonly label: string
  readonly directory: string
  readonly packageDirectory: string
}

/** Whether one directory is at or below another. */
const within = (directory: string, root: string): boolean =>
  root === "" || directory === root || directory.startsWith(`${root}/`)

/**
 * Whether one visibility label admits a consumer.
 *
 * The forms are the ones `Visibility.of` validates: `//...` for the whole
 * workspace, `//package/...` for a package and everything below it, `//package`
 * for every target of one package, and `//package:target` for one target.
 *
 * @category enforcement
 * @since 0.1.0
 */
export const labelAdmits = (pattern: string, consumer: Consumer): boolean => {
  if (pattern === "//...") return true
  const body = pattern.slice(2)
  if (body.endsWith("/...")) return within(consumer.directory, body.slice(0, -4))
  if (body.includes(":")) return consumer.label === pattern
  return consumer.directory === body
}

/**
 * Whether a producer's declared visibility admits one consumer.
 *
 * Every shorthand answers from the two directories and, for
 * {@link Visibility.Group}, the consumer's manifest. A group whose consumer has
 * no manifest is refused: a predicate over an absent manifest has no answer,
 * and admitting on a missing file would make the tightest declaration the
 * loosest.
 *
 * @category enforcement
 * @since 0.1.0
 */
export const admits = (
  visibility: Visibility.Visibility,
  producer: Producer,
  consumer: Consumer
): boolean => {
  switch (visibility._tag) {
    case "Private":
      return consumer.directory === producer.directory
    case "Package":
      return consumer.packageDirectory === producer.packageDirectory
    case "Subpackages":
      return within(consumer.directory, producer.directory)
    case "Public":
      return true
    case "Labels":
      return visibility.labels.some((label) => labelAdmits(label, consumer))
    case "Group":
      return consumer.manifest !== undefined && visibility.where(consumer.manifest) === true
  }
}

/**
 * Renders a visibility declaration the way a BUILD.ts file writes it.
 *
 * @category enforcement
 * @since 0.1.0
 */
export const describe = (visibility: Visibility.Visibility): string => {
  switch (visibility._tag) {
    case "Private":
      return "Visibility.private"
    case "Package":
      return "Visibility.package"
    case "Subpackages":
      return "Visibility.subpackages"
    case "Public":
      return "Visibility.public"
    case "Labels":
      return `Visibility.of(${visibility.labels.map((label) => JSON.stringify(label)).join(", ")})`
    case "Group":
      return "Visibility.group"
  }
}

/**
 * An import reaches a target whose visibility does not admit the importer.
 *
 * The message names the three facts a repair needs: the file that wrote the
 * import, the label it reaches, and the visibility that refused it.
 *
 * @category errors
 * @since 0.1.0
 */
export class VisibilityError extends Error {
  override readonly name = "VisibilityError"
  readonly file: string
  readonly imported: string
  readonly importer: string

  constructor(options: {
    readonly file: string
    readonly line: number
    readonly specifier: string
    readonly imported: string
    readonly importer: string
    readonly visibility: Visibility.Visibility
  }) {
    super(
      `${options.file}:${options.line} imports ${JSON.stringify(options.specifier)}, which resolves to ` +
        `${options.imported}. That target declares ${describe(options.visibility)} and does not admit ` +
        `${options.importer}.`
    )
    this.file = options.file
    this.imported = options.imported
    this.importer = options.importer
  }
}
