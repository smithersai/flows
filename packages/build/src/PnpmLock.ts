/**
 * Reading `pnpm-lock.yaml` as data.
 *
 * Nothing in this repository parses the lockfile. It is only digested: the
 * planner folds one sha256 of the whole file into ambient key material, and
 * `PackageManager.lockfileDigest` computes the same digest for the measure
 * action. One digest cannot say which packages a target depends on, so no
 * target can be keyed on the packages it actually uses. This module supplies
 * the missing capability: the lockfile becomes a list of packages, each with a
 * name, a version, a resolution, and its dependency edges.
 *
 * The scanner is targeted at the pnpm 9 lockfile format and is not a general
 * YAML implementation. `targets/src/GithubWorkflow.ts:18-26` records the house
 * precedent: a YAML dependency was rejected because the workspace dependency
 * policy is closed and `js-yaml` is only present transitively, so that module
 * hand-writes a targeted workflow scanner that refuses what it does not
 * understand. This module follows it. It handles exactly the constructs pnpm
 * writes — the four top-level sections, quoted and bare block-map keys, flow
 * maps and flow sequences as leaf values, block sequences, and the empty flow
 * map `{}` — and it fails with a named error on anything else.
 *
 * Failing closed matters more here than in a gate scanner. A partial parse
 * produces a package graph with missing edges, and a caller that keys work on
 * that graph records a key that omits a real input. Every refusal is therefore
 * a `PnpmLockError` naming the line, never a smaller graph. The completeness
 * checks in `crossCheck` exist for the same reason: a truncated file usually
 * still parses line by line, and only the cross-section checks catch it.
 *
 * The module reads a file and computes nothing else. It spawns no process,
 * consults no network, and holds no state, so it declares no service and no
 * `Layer`. Its only host access is `effect/FileSystem`, supplied by the
 * caller, and `read` bounds that access with `PackageManager.maximumLockfileBytes`,
 * the same bound the measure action already applies to this file.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Schema from "effect/Schema"
import { maximumLockfileBytes } from "./PackageManager.ts"

/**
 * The lockfile format versions this scanner accepts.
 *
 * A version outside this list is refused rather than attempted. pnpm changed
 * the meaning of the `packages` section between 6, 9, and later formats — in 9
 * it holds package metadata and `snapshots` holds the dependency edges — so a
 * scanner that guessed would report edges that the lockfile does not state.
 *
 * @category constants
 * @since 0.1.0
 */
export const supportedLockfileVersions: ReadonlyArray<string> = ["9.0"]

/**
 * Maximum bytes of lockfile source the scanner accepts.
 *
 * This is `PackageManager.maximumLockfileBytes`, the bound the measure action
 * already applies when it digests this file. The repository's own lockfile is
 * 839 KB today.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumSourceBytes = maximumLockfileBytes

/**
 * The stable error codes a lockfile read reports.
 *
 * @category models
 * @since 0.1.0
 */
export const ErrorCode = Schema.Literals([
  "lockfile_unreadable",
  "lockfile_too_large",
  "unsupported_version",
  "malformed",
  "incomplete"
])

/**
 * The stable error codes a lockfile read reports.
 *
 * @category models
 * @since 0.1.0
 */
export type ErrorCode = typeof ErrorCode.Type

/**
 * Error raised when a lockfile cannot be read as data.
 *
 * The identity string is frozen: it is journaled and folded into recorded
 * results, so renaming it invalidates cached work.
 *
 * @category errors
 * @since 0.1.0
 */
export class PnpmLockError extends Schema.TaggedError<PnpmLockError>()(
  "smithers-build/PnpmLockError",
  {
    code: ErrorCode,
    message: Schema.String,
    /** The 1-based source line the refusal points at, when the source was read. */
    line: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * One dependency edge of a snapshot.
 *
 * `alias` is the name the dependent imports, which differs from `name` when
 * the manifest declares an aliased dependency (`"cva": "npm:class-variance-authority@0.7.1"`).
 * `id` is the snapshot key the edge points at, so it carries the peer suffix.
 *
 * @category models
 * @since 0.1.0
 */
export interface Dependency {
  readonly alias: string
  readonly name: string
  readonly id: string
  /** Whether the edge came from `optionalDependencies`. */
  readonly optional: boolean
}

/**
 * One entry of the `snapshots` section: a package as resolved for one peer
 * combination, and the edges it has in that combination.
 *
 * Several snapshots can share one `packageKey`. That is the whole reason pnpm
 * splits the two sections: `foo@1.0.0` has one resolution and one integrity,
 * but a different dependency set per peer resolution.
 *
 * @category models
 * @since 0.1.0
 */
export interface Snapshot {
  /** The snapshot key as written, including any peer suffix. */
  readonly id: string
  /** The `packages` key this snapshot resolves, with the peer suffix removed. */
  readonly packageKey: string
  /** Edges from `dependencies` and `optionalDependencies`, sorted by alias. */
  readonly dependencies: ReadonlyArray<Dependency>
  /** The names listed under `transitivePeerDependencies`, sorted. */
  readonly transitivePeerDependencies: ReadonlyArray<string>
  /** Whether the snapshot declares `optional: true`. */
  readonly optional: boolean
}

/**
 * One entry of the `packages` section: a package version and how it resolves.
 *
 * @category models
 * @since 0.1.0
 */
export interface Package {
  /** The `packages` key as written, `name@version`. */
  readonly key: string
  readonly name: string
  readonly version: string
  /**
   * The `integrity` field of the resolution, or `undefined` for a resolution
   * that states none, such as a directory or a git resolution.
   */
  readonly integrity: string | undefined
  /** Every field of the resolution flow map, in sorted key order. */
  readonly resolution: Readonly<Record<string, string>>
}

/**
 * One declared dependency of one workspace importer.
 *
 * The `version` field is recorded as written and is not resolved. It is a
 * snapshot key for a registry dependency and a `link:` path for a workspace
 * dependency, and the two are not interchangeable.
 *
 * @category models
 * @since 0.1.0
 */
export interface ImporterDependency {
  readonly group: string
  readonly name: string
  readonly specifier: string
  readonly version: string
}

/**
 * One entry of the `importers` section: a workspace project and what it declares.
 *
 * @category models
 * @since 0.1.0
 */
export interface Importer {
  /** The importer key, a workspace-relative directory or `.` for the root. */
  readonly id: string
  /** Declared dependencies, sorted by group then name. */
  readonly dependencies: ReadonlyArray<ImporterDependency>
}

/**
 * A parsed lockfile.
 *
 * Every array is sorted by its key, so two parses of the same bytes are
 * structurally identical and the whole value is safe to serialize as part of a
 * cache key.
 *
 * @category models
 * @since 0.1.0
 */
export interface Lockfile {
  readonly version: string
  readonly importers: ReadonlyArray<Importer>
  readonly packages: ReadonlyArray<Package>
  readonly snapshots: ReadonlyArray<Snapshot>
  /**
   * Top-level sections the scanner skipped, sorted.
   *
   * `settings`, `overrides`, `patchedDependencies`, and their peers describe
   * how the graph was produced, not what it contains, and their effect is
   * already visible in the resolved versions and integrities this module
   * reports. They are named here rather than dropped silently so a caller can
   * see what it did not get.
   */
  readonly ignoredSections: ReadonlyArray<string>
}

/** @private */
interface Line {
  readonly number: number
  readonly indent: number
  readonly text: string
}

/** @private */
const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

/** @private */
const refuse = (code: ErrorCode, line: number, message: string): PnpmLockError =>
  new PnpmLockError({ code, message: `line ${line}: ${message}`, line })

/**
 * Counts the UTF-8 bytes of a string without allocating a copy of it.
 *
 * @private
 */
const utf8ByteLength = (source: string): number => {
  let bytes = 0
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < source.length) {
      const low = source.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4
        index += 1
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}

/**
 * Strips a trailing comment that is not inside a quoted scalar.
 *
 * pnpm writes no comments. A hand-edited lockfile can carry them, and reading
 * one as data would produce a version or an integrity with a comment glued to
 * it.
 *
 * @private
 */
const stripComment = (text: string): string => {
  let quote: string | undefined
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!
    if (quote !== undefined) {
      if (quote === "'" && character === "'" && text[index + 1] === "'") {
        index += 1
        continue
      }
      if (quote === "\"" && character === "\\") {
        index += 1
        continue
      }
      if (character === quote) quote = undefined
      continue
    }
    if (character === "'" || character === "\"") {
      quote = character
      continue
    }
    if (character === "#" && (index === 0 || text[index - 1] === " ")) return text.slice(0, index)
  }
  return text
}

/**
 * Decodes the quoted scalar forms the scanner supports.
 *
 * Single quotes are pnpm's own quoting for keys and versions. Double-quoted
 * scalars are decoded only where JSON agrees with YAML, and refused otherwise:
 * YAML has escapes JSON does not, and inventing a character inside a package
 * name or an integrity would produce a wrong identity rather than a refusal.
 *
 * @private
 */
const decodeScalar = (value: string, line: number): string => {
  const trimmed = value.trim()
  if (!trimmed.startsWith("'") && !trimmed.startsWith("\"")) return trimmed
  const quote = trimmed[0]!
  if (trimmed.length < 2 || !trimmed.endsWith(quote)) {
    throw refuse("malformed", line, `unterminated quoted scalar ${JSON.stringify(trimmed)}`)
  }
  if (quote === "\"") {
    try {
      const decoded: unknown = JSON.parse(trimmed)
      if (typeof decoded === "string") return decoded
    } catch {
      // Fall through to the refusal below.
    }
    throw refuse("malformed", line, `unsupported double-quoted scalar ${JSON.stringify(trimmed)}`)
  }
  const inner = trimmed.slice(1, -1)
  let decoded = ""
  for (let index = 0; index < inner.length; index++) {
    const character = inner[index]!
    if (character !== "'") {
      decoded += character
      continue
    }
    if (inner[index + 1] !== "'") {
      throw refuse("malformed", line, `unsupported single-quoted scalar ${JSON.stringify(trimmed)}`)
    }
    decoded += "'"
    index += 1
  }
  return decoded
}

/**
 * Splits the source into significant lines.
 *
 * Tab indentation is refused. YAML forbids it, and accepting it would shift
 * the structure this scanner derives entirely from indentation.
 *
 * @private
 */
const significantLines = (source: string): ReadonlyArray<Line> => {
  const lines: Array<Line> = []
  const raw = source.split("\n")
  for (let index = 0; index < raw.length; index++) {
    const original = raw[index]!
    const leading = original.slice(0, original.search(/\S|$/))
    if (leading.includes("\t")) throw refuse("malformed", index + 1, "tab indentation is not valid YAML")
    const withoutComment = stripComment(original)
    if (withoutComment.trim() === "") continue
    lines.push({
      number: index + 1,
      indent: withoutComment.length - withoutComment.trimStart().length,
      text: withoutComment.trimEnd()
    })
  }
  return lines
}

/** @private */
const keyAndValue = (line: Line): { readonly key: string; readonly value: string } => {
  const text = line.text.trimStart()
  let quote: string | undefined
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!
    if (quote !== undefined) {
      if (quote === "'" && character === "'" && text[index + 1] === "'") {
        index += 1
        continue
      }
      if (character === quote) quote = undefined
      continue
    }
    if (character === "'" || character === "\"") {
      quote = character
      continue
    }
    if (character === ":" && (index + 1 === text.length || text[index + 1] === " ")) {
      return {
        key: decodeScalar(text.slice(0, index), line.number),
        value: text.slice(index + 1).trim()
      }
    }
  }
  throw refuse("malformed", line.number, `expected a \`key: value\` mapping, read ${JSON.stringify(text)}`)
}

/**
 * The index of the first line at or below `indent`, starting from `start`.
 *
 * @private
 */
const blockEnd = (lines: ReadonlyArray<Line>, start: number, indent: number): number => {
  let index = start
  while (index < lines.length && lines[index]!.indent > indent) index += 1
  return index
}

/** @private */
interface Entry {
  readonly line: Line
  readonly key: string
  readonly value: string
  /** Every line of the entry's subtree, at any depth below its own. */
  readonly body: ReadonlyArray<Line>
  readonly next: number
}

/**
 * The entry that opens at `start`: its key, its inline value, and its subtree.
 *
 * @private
 */
const entryAt = (lines: ReadonlyArray<Line>, start: number): Entry => {
  const line = lines[start]!
  const pair = keyAndValue(line)
  const end = blockEnd(lines, start + 1, line.indent)
  return { line, key: pair.key, value: pair.value, body: lines.slice(start + 1, end), next: end }
}

/**
 * The sibling entries of one block.
 *
 * Siblings share one indentation. A block whose lines disagree about it is
 * refused: YAML would read the deeper line as a child of something this
 * scanner has already closed, and the two readings differ.
 *
 * @private
 */
const entriesOf = (block: ReadonlyArray<Line>): ReadonlyArray<Entry> => {
  const result: Array<Entry> = []
  if (block.length === 0) return result
  const indent = block[0]!.indent
  let index = 0
  while (index < block.length) {
    const current = entryAt(block, index)
    if (current.line.indent !== indent) {
      throw refuse("malformed", current.line.number, `expected indentation ${indent}, read ${current.line.indent}`)
    }
    result.push(current)
    index = current.next
  }
  return result
}

/**
 * Reads a flow map (`{a: b, c: d}`) into sorted key order.
 *
 * Nested flow collections are refused: no pnpm resolution writes one, and a
 * scanner that split on commas inside one would produce wrong fields.
 *
 * @private
 */
const flowMap = (value: string, line: number): Record<string, string> => {
  const inner = value.slice(1, -1).trim()
  const fields: Record<string, string> = {}
  if (inner === "") return fields
  if (inner.includes("{") || inner.includes("[")) {
    throw refuse("malformed", line, `nested flow collection in ${JSON.stringify(value)}`)
  }
  const entries: Array<readonly [string, string]> = []
  for (const part of splitFlow(inner, line)) {
    const separator = part.indexOf(":")
    if (separator === -1) throw refuse("malformed", line, `flow map field without a value: ${JSON.stringify(part)}`)
    entries.push([
      decodeScalar(part.slice(0, separator), line),
      decodeScalar(part.slice(separator + 1), line)
    ])
  }
  for (const [key, field] of entries.slice().sort((left, right) => compare(left[0], right[0]))) {
    if (Object.hasOwn(fields, key)) throw refuse("malformed", line, `duplicate flow map key ${JSON.stringify(key)}`)
    fields[key] = field
  }
  return fields
}

/**
 * Splits a flow collection body on commas that are not inside a quoted scalar.
 *
 * @private
 */
const splitFlow = (inner: string, line: number): ReadonlyArray<string> => {
  const parts: Array<string> = []
  let current = ""
  let quote: string | undefined
  for (let index = 0; index < inner.length; index++) {
    const character = inner[index]!
    if (quote !== undefined) {
      current += character
      if (quote === "'" && character === "'" && inner[index + 1] === "'") {
        current += "'"
        index += 1
        continue
      }
      if (character === quote) quote = undefined
      continue
    }
    if (character === "'" || character === "\"") {
      quote = character
      current += character
      continue
    }
    if (character === ",") {
      parts.push(current)
      current = ""
      continue
    }
    current += character
  }
  if (quote !== undefined) throw refuse("malformed", line, "unterminated quoted scalar in a flow collection")
  parts.push(current)
  return parts.map((part) => part.trim()).filter((part) => part !== "")
}

/**
 * The offset of the first `(`, which opens the peer suffix, or the string
 * length when the key has no suffix.
 *
 * The first `(` is the right one at every depth: pnpm nests peer suffixes
 * inside a suffix it has already opened, never beside one.
 *
 * @private
 */
const suffixStart = (id: string): number => {
  const opened = id.indexOf("(")
  return opened === -1 ? id.length : opened
}

/**
 * Splits `name@version` into its two halves.
 *
 * The version is everything after the last `@` outside a peer suffix, which is
 * the only rule that works for a scoped name, whose first character is also an
 * `@`.
 *
 * @private
 */
const splitKey = (key: string, line: number): { readonly name: string; readonly version: string } => {
  const base = key.slice(0, suffixStart(key))
  const separator = base.lastIndexOf("@")
  if (separator <= 0 || separator === base.length - 1) {
    throw refuse("malformed", line, `expected a \`name@version\` key, read ${JSON.stringify(key)}`)
  }
  return { name: base.slice(0, separator), version: base.slice(separator + 1) + key.slice(base.length) }
}

/**
 * Whether a dependency value is a full `name@version` reference rather than a
 * bare version.
 *
 * pnpm writes an aliased dependency as `cva: class-variance-authority@0.7.1`
 * and an ordinary one as `effect: 4.0.0-rc.108(x@1.0.0)`. The two are told
 * apart structurally: an `@` outside the peer suffix, and past a leading one,
 * only ever separates a name from a version.
 *
 * @private
 */
const isAliasReference = (value: string): boolean => {
  const head = value.slice(0, suffixStart(value))
  return head.indexOf("@", 1) > 0
}

/** @private */
const parseImporters = (block: ReadonlyArray<Line>): ReadonlyArray<Importer> => {
  const importers: Array<Importer> = []
  const seen = new Set<string>()
  for (const current of entriesOf(block)) {
    if (current.value !== "") {
      throw refuse("malformed", current.line.number, `importer ${JSON.stringify(current.key)} has an inline value`)
    }
    if (seen.has(current.key)) {
      throw refuse("malformed", current.line.number, `duplicate importer ${JSON.stringify(current.key)}`)
    }
    seen.add(current.key)
    const dependencies: Array<ImporterDependency> = []
    for (const group of entriesOf(current.body)) {
      if (group.value !== "") {
        throw refuse(
          "malformed",
          group.line.number,
          `dependency group ${JSON.stringify(group.key)} has an inline value`
        )
      }
      for (const member of entriesOf(group.body)) {
        if (member.value !== "") {
          throw refuse("malformed", member.line.number, `dependency ${JSON.stringify(member.key)} has an inline value`)
        }
        const fields: Record<string, string> = {}
        for (const field of entriesOf(member.body)) {
          fields[field.key] = decodeScalar(field.value, field.line.number)
        }
        const specifier = fields["specifier"]
        const version = fields["version"]
        if (specifier === undefined || version === undefined) {
          throw refuse(
            "malformed",
            member.line.number,
            `dependency ${JSON.stringify(member.key)} needs both a specifier and a version`
          )
        }
        dependencies.push({ group: group.key, name: member.key, specifier, version })
      }
    }
    dependencies.sort((left, right) => compare(left.group, right.group) || compare(left.name, right.name))
    importers.push({ id: current.key, dependencies })
  }
  importers.sort((left, right) => compare(left.id, right.id))
  return importers
}

/** @private */
const parsePackages = (block: ReadonlyArray<Line>): ReadonlyArray<Package> => {
  const packages: Array<Package> = []
  const seen = new Set<string>()
  for (const current of entriesOf(block)) {
    if (current.value !== "") {
      throw refuse("malformed", current.line.number, `package ${JSON.stringify(current.key)} has an inline value`)
    }
    if (seen.has(current.key)) {
      throw refuse("malformed", current.line.number, `duplicate package ${JSON.stringify(current.key)}`)
    }
    seen.add(current.key)
    const split = splitKey(current.key, current.line.number)
    let resolution: Record<string, string> | undefined
    for (const field of entriesOf(current.body)) {
      // `engines`, `cpu`, `os`, `libc`, `hasBin`, `deprecated`,
      // `peerDependencies`, `peerDependenciesMeta`, and `bundledDependencies`
      // are consumed and dropped: none of them names an input this module
      // reports, and a scanner that reported them would invite a caller to key
      // work on a field pnpm may reformat.
      if (field.key !== "resolution") continue
      if (!field.value.startsWith("{") || !field.value.endsWith("}")) {
        throw refuse(
          "malformed",
          field.line.number,
          `expected a resolution flow map, read ${JSON.stringify(field.value)}`
        )
      }
      if (resolution !== undefined) {
        throw refuse("malformed", field.line.number, `package ${JSON.stringify(current.key)} states two resolutions`)
      }
      resolution = flowMap(field.value, field.line.number)
    }
    if (resolution === undefined) {
      throw refuse("malformed", current.line.number, `package ${JSON.stringify(current.key)} states no resolution`)
    }
    packages.push({
      key: current.key,
      name: split.name,
      version: split.version,
      integrity: resolution["integrity"],
      resolution
    })
  }
  packages.sort((left, right) => compare(left.key, right.key))
  return packages
}

/** @private */
const parseEdges = (group: Entry, optional: boolean, into: Array<Dependency>): void => {
  for (const member of entriesOf(group.body)) {
    if (member.body.length > 0) {
      throw refuse("malformed", member.line.number, `dependency ${JSON.stringify(member.key)} has a nested block`)
    }
    const value = decodeScalar(member.value, member.line.number)
    if (value === "") {
      throw refuse("malformed", member.line.number, `dependency ${JSON.stringify(member.key)} states no version`)
    }
    const id = isAliasReference(value) ? value : `${member.key}@${value}`
    into.push({ alias: member.key, name: splitKey(id, member.line.number).name, id, optional })
  }
}

/** @private */
const parseSnapshots = (block: ReadonlyArray<Line>): ReadonlyArray<Snapshot> => {
  const snapshots: Array<Snapshot> = []
  const seen = new Set<string>()
  for (const current of entriesOf(block)) {
    if (current.value !== "" && current.value !== "{}") {
      throw refuse("malformed", current.line.number, `snapshot ${JSON.stringify(current.key)} has an inline value`)
    }
    if (seen.has(current.key)) {
      throw refuse("malformed", current.line.number, `duplicate snapshot ${JSON.stringify(current.key)}`)
    }
    seen.add(current.key)
    const dependencies: Array<Dependency> = []
    const transitivePeerDependencies: Array<string> = []
    let optional = false
    for (const field of entriesOf(current.body)) {
      switch (field.key) {
        case "dependencies":
          parseEdges(field, false, dependencies)
          break
        case "optionalDependencies":
          parseEdges(field, true, dependencies)
          break
        case "transitivePeerDependencies":
          for (const item of field.body) {
            const text = item.text.trimStart()
            if (!text.startsWith("- ")) throw refuse("malformed", item.number, "expected a `- name` sequence item")
            transitivePeerDependencies.push(decodeScalar(text.slice(2), item.number))
          }
          break
        case "optional":
          if (field.value !== "true" && field.value !== "false") {
            throw refuse("malformed", field.line.number, `expected a boolean, read ${JSON.stringify(field.value)}`)
          }
          optional = field.value === "true"
          break
        default:
          throw refuse("malformed", field.line.number, `unsupported snapshot field ${JSON.stringify(field.key)}`)
      }
    }
    dependencies.sort((left, right) => compare(left.alias, right.alias) || compare(left.id, right.id))
    transitivePeerDependencies.sort(compare)
    snapshots.push({
      id: current.key,
      packageKey: current.key.slice(0, suffixStart(current.key)),
      dependencies,
      transitivePeerDependencies,
      optional
    })
  }
  snapshots.sort((left, right) => compare(left.id, right.id))
  return snapshots
}

/**
 * Holds the two package sections to each other.
 *
 * pnpm writes one `packages` entry per resolved package version, at least one
 * `snapshots` entry per `packages` entry, and an edge only to a snapshot the
 * same file defines. Checking all three is what makes a truncated file a
 * refusal: truncation leaves the surviving lines well formed, so the line
 * scanner cannot see it, but it always breaks one of these.
 *
 * @private
 */
const crossCheck = (lockfile: Lockfile): void => {
  const packageKeys = new Set(lockfile.packages.map((item) => item.key))
  const snapshotIds = new Set(lockfile.snapshots.map((item) => item.id))
  const resolved = new Set<string>()
  for (const snapshot of lockfile.snapshots) {
    if (!packageKeys.has(snapshot.packageKey)) {
      throw new PnpmLockError({
        code: "incomplete",
        message: `snapshot ${snapshot.id} resolves ${snapshot.packageKey}, which the packages section does not define`
      })
    }
    resolved.add(snapshot.packageKey)
    for (const dependency of snapshot.dependencies) {
      if (!snapshotIds.has(dependency.id)) {
        throw new PnpmLockError({
          code: "incomplete",
          message: `snapshot ${snapshot.id} depends on ${dependency.id}, which the snapshots section does not define`
        })
      }
    }
  }
  for (const item of lockfile.packages) {
    if (!resolved.has(item.key)) {
      throw new PnpmLockError({ code: "incomplete", message: `package ${item.key} has no snapshot` })
    }
  }
}

/** @private */
const parseLockfile = (source: string, maximumBytes: number): Lockfile => {
  if (utf8ByteLength(source) > maximumBytes) {
    throw new PnpmLockError({
      code: "lockfile_too_large",
      message: `lockfile source is larger than ${maximumBytes} bytes`
    })
  }
  const lines = significantLines(source)
  let version: string | undefined
  let importers: ReadonlyArray<Importer> = []
  let packages: ReadonlyArray<Package> = []
  let snapshots: ReadonlyArray<Snapshot> = []
  const ignoredSections: Array<string> = []
  const seen = new Set<string>()
  for (const current of entriesOf(lines)) {
    if (current.line.indent !== 0) {
      throw refuse("malformed", current.line.number, "expected a top-level section at indentation 0")
    }
    if (seen.has(current.key)) {
      throw refuse("malformed", current.line.number, `duplicate top-level section ${JSON.stringify(current.key)}`)
    }
    seen.add(current.key)
    if (current.key !== "lockfileVersion" && current.value !== "") {
      throw refuse("malformed", current.line.number, `section ${JSON.stringify(current.key)} has an inline value`)
    }
    switch (current.key) {
      case "lockfileVersion": {
        version = decodeScalar(current.value, current.line.number)
        if (!supportedLockfileVersions.includes(version)) {
          throw new PnpmLockError({
            code: "unsupported_version",
            message: `lockfileVersion ${JSON.stringify(version)} is not one of ${supportedLockfileVersions.join(", ")}`,
            line: current.line.number
          })
        }
        break
      }
      case "importers":
        importers = parseImporters(current.body)
        break
      case "packages":
        packages = parsePackages(current.body)
        break
      case "snapshots":
        snapshots = parseSnapshots(current.body)
        break
      default:
        ignoredSections.push(current.key)
    }
  }
  if (version === undefined) {
    throw new PnpmLockError({ code: "unsupported_version", message: "the source states no lockfileVersion" })
  }
  ignoredSections.sort(compare)
  const lockfile: Lockfile = { version, importers, packages, snapshots, ignoredSections }
  crossCheck(lockfile)
  return lockfile
}

/**
 * Reads lockfile source as data, throwing on refusal.
 *
 * The call is synchronous and throws `PnpmLockError`. It exists for callers
 * that evaluate outside an Effect, such as a `BUILD.ts` declaration, which is
 * plain synchronous TypeScript. Callers inside a flow use `parse`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const parseSync = (
  source: string,
  options: { readonly maximumBytes?: number } = {}
): Lockfile => parseLockfile(source, options.maximumBytes ?? maximumSourceBytes)

/**
 * Reads lockfile source as data.
 *
 * @category constructors
 * @since 0.1.0
 */
export const parse = (
  source: string,
  options: { readonly maximumBytes?: number } = {}
): Effect.Effect<Lockfile, PnpmLockError> =>
  Effect.try({
    try: () => parseLockfile(source, options.maximumBytes ?? maximumSourceBytes),
    catch: (cause) =>
      cause instanceof PnpmLockError
        ? cause
        : new PnpmLockError({ code: "malformed", message: "could not read the lockfile source", cause })
  })

/**
 * Reads a lockfile from the filesystem and parses it.
 *
 * The read is bounded before it happens: a path that is not a regular file, or
 * one larger than the bound, is refused rather than loaded. That is the
 * discipline `PackageManager` already applies to every project file it admits,
 * and the default bound is its own `maximumLockfileBytes`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const read = (
  path: string,
  options: { readonly maximumBytes?: number } = {}
): Effect.Effect<Lockfile, PnpmLockError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const limit = options.maximumBytes ?? maximumSourceBytes
    const unreadable = (cause: unknown) =>
      new PnpmLockError({ code: "lockfile_unreadable", message: `could not read ${path}`, cause })
    const info = yield* fs.stat(path).pipe(Effect.mapError(unreadable))
    if (info.type !== "File") {
      return yield* Effect.fail(
        new PnpmLockError({ code: "lockfile_unreadable", message: `${path} is not a regular file` })
      )
    }
    if (info.size > BigInt(limit)) {
      return yield* Effect.fail(
        new PnpmLockError({ code: "lockfile_too_large", message: `${path} is larger than ${limit} bytes` })
      )
    }
    const source = yield* fs.readFileString(path).pipe(Effect.mapError(unreadable))
    return yield* parse(source, { maximumBytes: limit })
  })

/**
 * The `packages` entry with this key, or `undefined`.
 *
 * @category accessors
 * @since 0.1.0
 */
export const packageEntry = (lockfile: Lockfile, key: string): Package | undefined =>
  lockfile.packages.find((item) => item.key === key)

/**
 * Every `packages` entry for one package name, in key order.
 *
 * A name has more than one entry when the workspace resolves more than one
 * version of it.
 *
 * @category accessors
 * @since 0.1.0
 */
export const packagesNamed = (lockfile: Lockfile, name: string): ReadonlyArray<Package> =>
  lockfile.packages.filter((item) => item.name === name)

/**
 * The `snapshots` entry with this id, or `undefined`.
 *
 * @category accessors
 * @since 0.1.0
 */
export const snapshotEntry = (lockfile: Lockfile, id: string): Snapshot | undefined =>
  lockfile.snapshots.find((item) => item.id === id)

/**
 * Every `snapshots` entry that resolves one package name, in id order.
 *
 * @category accessors
 * @since 0.1.0
 */
export const snapshotsNamed = (lockfile: Lockfile, name: string): ReadonlyArray<Snapshot> => {
  const keys = new Set(packagesNamed(lockfile, name).map((item) => item.key))
  return lockfile.snapshots.filter((item) => keys.has(item.packageKey))
}

/**
 * The transitive closure of one snapshot, including the snapshot itself.
 *
 * The result is sorted by id, so it is the same list whatever order the walk
 * discovered it in. Cycles terminate: pnpm's graph has them, and the visited
 * set is what makes the walk total.
 *
 * @category accessors
 * @since 0.1.0
 */
export const closure = (lockfile: Lockfile, id: string): Effect.Effect<ReadonlyArray<string>, PnpmLockError> =>
  Effect.suspend(() => {
    const index = new Map(lockfile.snapshots.map((item) => [item.id, item] as const))
    const visited = new Set<string>()
    const pending = [id]
    while (pending.length > 0) {
      const current = pending.pop()!
      if (visited.has(current)) continue
      const snapshot = index.get(current)
      if (snapshot === undefined) {
        return Effect.fail(
          new PnpmLockError({ code: "incomplete", message: `the lockfile defines no snapshot ${current}` })
        )
      }
      visited.add(current)
      for (const dependency of snapshot.dependencies) pending.push(dependency.id)
    }
    return Effect.succeed([...visited].sort(compare))
  })

/**
 * A stable text rendering of one snapshot and its transitive closure.
 *
 * The rendering names every identity that decides what the closure installs:
 * each snapshot id, the integrity of the package it resolves, and each edge as
 * `alias -> id`. It is sorted throughout and carries no path, no timestamp, and
 * no host fact, so digesting it yields a value that changes when the closure
 * changes and only then. A caller that keys work on one npm package digests
 * this.
 *
 * @category accessors
 * @since 0.1.0
 */
export const closureText = (lockfile: Lockfile, id: string): Effect.Effect<string, PnpmLockError> =>
  Effect.gen(function*() {
    const ids = yield* closure(lockfile, id)
    const lines: Array<string> = []
    for (const member of ids) {
      const snapshot = snapshotEntry(lockfile, member)!
      const item = packageEntry(lockfile, snapshot.packageKey)
      if (item === undefined) {
        return yield* Effect.fail(
          new PnpmLockError({
            code: "incomplete",
            message: `the lockfile defines no package ${snapshot.packageKey}`
          })
        )
      }
      lines.push(`${member} ${item.integrity ?? "-"}`)
      for (const dependency of snapshot.dependencies) {
        lines.push(`  ${dependency.alias}${dependency.optional ? "?" : ""} -> ${dependency.id}`)
      }
    }
    return lines.join("\n")
  })
