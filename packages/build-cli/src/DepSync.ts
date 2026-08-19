/**
 * Maintains the dependency section of a `BUILD.ts` file from the imports its
 * package's sources actually write.
 *
 * `PackageDefaults` passes one static attrs record to every directory it
 * matches, so every synthesized package gets an empty `deps` list and no
 * dependency edges even when its manifest names workspace siblings
 * (`packages/build/docs/extending/default-rules.md:104-124`). A package that
 * needs an edge therefore carries a hand-written `BUILD.ts` whose only
 * irreducible content is that edge: `packages/engine/BUILD.ts` exists for
 * `deps: [flow]` and `packages/flow/BUILD.ts` for `deps: [plan]`. This module
 * derives those edges from the real import graph, so the declaration is a fact
 * about the code rather than a fact a person remembered to write down.
 *
 * The edit is surgical. A `BUILD.ts` is hand-written and carries rationale in
 * its comments, so write mode inserts one import statement and one array
 * element and leaves every other byte alone. It never renders a file.
 *
 * The mode duality is D11's, applied to `BUILD.ts` itself: `check` reads and
 * fails on drift, `write` mutates. Write mode is refused when `NODE_ENV` is
 * `production` and when the strict flag is set, which is what makes CI a gate
 * rather than a generator.
 *
 * Import scanning, specifier parsing, and path normalization come from
 * {@link Imports}; this module adds only what a surgical edit needs and
 * {@link Imports} deliberately does not have, which is byte offsets into a
 * `BUILD.ts`.
 *
 * Two policies this module declares rather than infers:
 *
 * - **A type-only import is an edge.** The 45 per-package `scripts/circular.mjs`
 *   copies run madge with `skipTypeImports: true`, because a type-only cycle is
 *   not a runtime cycle. A build edge is the opposite case: `tsc` cannot
 *   compile a consumer until the producer's declarations exist, so a type-only
 *   import is exactly the ordering constraint `deps` encodes. {@link Imports}
 *   states the same rule for visibility.
 * - **Edges are only ever added.** A declared dep with no matching import may
 *   still be a deliberate ordering edge, and deleting a hand-written line is
 *   not something a self-updating mechanism should do unasked. Drift means a
 *   missing edge, never a surplus one.
 *
 * Nothing here reads the filesystem except the write half, which publishes
 * through `GeneratedFile.writeGeneratedFile` so a `BUILD.ts` is replaced by the
 * same atomic rename every other generated file uses. {@link plan} takes the
 * workspace facts as arguments and answers in a browser.
 *
 * @since 0.1.0
 */
import * as GeneratedFile from "@smthrs/targets/GeneratedFile"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Imports from "./Imports.ts"

/**
 * One workspace package: the name its manifest declares and the directory that
 * holds it, workspace-relative and slash-separated.
 *
 * @category models
 * @since 0.1.0
 */
export interface Package {
  readonly name: string
  readonly directory: string
}

/**
 * One source file of the package whose `BUILD.ts` is being maintained.
 *
 * The caller chooses the file set, which is the same choice a target's `srcs`
 * makes. Passing test sources as well produces the union of build and test
 * edges, which is what the six hand-written `BUILD.ts` files declare.
 *
 * @category models
 * @since 0.1.0
 */
export interface Source {
  readonly path: string
  readonly text: string
}

/**
 * The import that proves one edge.
 *
 * @category models
 * @since 0.1.0
 */
export interface Evidence {
  readonly file: string
  readonly line: number
  readonly specifier: string
  readonly typeOnly: boolean
}

/**
 * One dependency edge a `BUILD.ts` does not declare.
 *
 * `binding` is the local name the edge uses in the file: an existing import's
 * binding when the sibling `BUILD.ts` is already imported, and a fresh
 * identifier otherwise.
 *
 * @category models
 * @since 0.1.0
 */
export interface Edge {
  readonly name: string
  readonly directory: string
  readonly binding: string
  readonly evidence: Evidence
}

/**
 * Everything one dependency-section decision reads.
 *
 * `path` is the workspace-relative `BUILD.ts` path, which fixes the directory
 * every relative specifier resolves against. `target` is the export name a
 * sibling `BUILD.ts` publishes for its library target.
 *
 * @category models
 * @since 0.1.0
 */
export interface Request {
  readonly path: string
  readonly contents: string
  readonly sources: ReadonlyArray<Source>
  readonly packages: ReadonlyArray<Package>
  readonly target?: string | undefined
}

/**
 * The decision {@link plan} reaches.
 *
 * `contents` is the input contents when nothing is missing and when the edit
 * has nowhere to go, so a caller that writes it unconditionally still
 * reproduces the file byte for byte. `blocked` names why the edit could not be
 * placed, and is undefined when there was an edit and it was placed.
 *
 * @category models
 * @since 0.1.0
 */
export interface Plan {
  readonly path: string
  readonly declared: ReadonlyArray<string>
  readonly missing: ReadonlyArray<Edge>
  readonly contents: string
  readonly blocked: string | undefined
}

/**
 * Whether write mode may run.
 *
 * Both fields are supplied by the caller rather than read from `process`, so
 * the gate is a value a test states and a browser host can answer.
 *
 * @category models
 * @since 0.1.0
 */
export interface Environment {
  readonly production: boolean
  readonly strict: boolean
}

/**
 * Reads the write gate out of an environment record and a strict flag.
 *
 * @category constructors
 * @since 0.1.0
 */
export const environment = (options: {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly strict: boolean
}): Environment => ({ production: options.env["NODE_ENV"] === "production", strict: options.strict })

/**
 * Why write mode is refused, or undefined when it may run.
 *
 * @category enforcement
 * @since 0.1.0
 */
export const refusal = (environment: Environment): string | undefined => {
  if (environment.production) return "NODE_ENV is production, which is check-only"
  if (environment.strict) return "strict mode is on, which is check-only"
  return undefined
}

/**
 * Write mode ran where only check mode is allowed.
 *
 * @category errors
 * @since 0.1.0
 */
export class RefusedError extends Schema.TaggedError<RefusedError>()(
  "smithers-build/DepSyncRefusedError",
  {
    path: Schema.NonEmptyString,
    reason: Schema.NonEmptyString
  }
) {}

/**
 * A missing edge has nowhere to go in the file that needs it.
 *
 * @category errors
 * @since 0.1.0
 */
export class PlacementError extends Schema.TaggedError<PlacementError>()(
  "smithers-build/DepSyncPlacementError",
  {
    path: Schema.NonEmptyString,
    reason: Schema.NonEmptyString
  }
) {}

/** The export a sibling `BUILD.ts` publishes for its library target. */
const defaultTarget = "lib"

/**
 * Replaces every comment body and string body with spaces, keeping offsets.
 *
 * {@link Imports.scan} answers which specifiers a file imports and nothing
 * about where they sit, and a surgical edit needs positions: the end of the
 * last import statement and the bounds of a `deps` array. Masking is how those
 * positions stay honest. `packages/flow/BUILD.ts` writes `deps: [plan]` inside
 * a doc comment, and an unmasked scan would edit the comment.
 */
const mask = (text: string): string => {
  const out = new Array<string>(text.length)
  let index = 0
  const blank = (stop: number): void => {
    while (index < stop && index < text.length) {
      const character = text[index]!
      out[index] = character === "\n" ? "\n" : " "
      index += 1
    }
  }
  while (index < text.length) {
    const character = text[index]!
    const next = text[index + 1]
    if (character === "/" && next === "/") {
      const end = text.indexOf("\n", index)
      blank(end < 0 ? text.length : end)
      continue
    }
    if (character === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2)
      blank(end < 0 ? text.length : end + 2)
      continue
    }
    if (character === "\"" || character === "'" || character === "`") {
      out[index] = character
      index += 1
      while (index < text.length) {
        const inner = text[index]!
        if (inner === "\\") {
          out[index] = " "
          index += 1
          if (index < text.length) {
            out[index] = " "
            index += 1
          }
          continue
        }
        if (inner === character) {
          out[index] = character
          index += 1
          break
        }
        out[index] = inner === "\n" ? "\n" : " "
        index += 1
      }
      continue
    }
    out[index] = character
    index += 1
  }
  return out.join("")
}

/** Every import statement, as a half-open range over the masked text. */
const importStatements = (masked: string): ReadonlyArray<{ readonly start: number; readonly end: number }> => {
  const pattern = /(?:^|[;\n])[ \t]*import\s+[^"']*(["'])[^"'\n]*\1/g
  const found: Array<{ readonly start: number; readonly end: number }> = []
  for (const match of masked.matchAll(pattern)) {
    const leading = /^[;\n]/.test(match[0]) ? 1 : 0
    found.push({ start: match.index + leading, end: match.index + match[0].length })
  }
  return found
}

interface Binding {
  readonly directory: string
  readonly exported: string
  readonly local: string
}

/** The `{ lib as flow } from "../flow/BUILD.ts"` imports the file already writes. */
const siblingBindings = (
  contents: string,
  masked: string,
  directory: string,
  real: ReadonlySet<string>
): ReadonlyArray<Binding> => {
  const pattern = /(?:^|[;\n])[ \t]*import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(["'])[^"'\n]*\2/g
  const found: Array<Binding> = []
  for (const match of masked.matchAll(pattern)) {
    const statement = contents.slice(match.index, match.index + match[0].length)
    const specifier = /(["'])([^"'\n]*)\1\s*$/.exec(statement)?.[2]
    if (specifier === undefined || !real.has(specifier)) continue
    const resolved = Imports.normalize(directory === "" ? specifier : `${directory}/${specifier}`)
    if (resolved === undefined || !resolved.endsWith("/BUILD.ts")) continue
    const owner = resolved.slice(0, -"/BUILD.ts".length)
    for (const entry of match[1]!.split(",")) {
      const parts = entry.trim().split(/\s+as\s+/)
      const exported = parts[0]?.trim()
      if (exported === undefined || exported === "" || exported === "type") continue
      found.push({ directory: owner, exported, local: (parts[1] ?? exported).trim() })
    }
  }
  return found
}

/** Walks from an opening bracket to the bracket that closes it. */
const closes = (masked: string, open: number): number | undefined => {
  let depth = 0
  for (let index = open; index < masked.length; index += 1) {
    const character = masked[index]!
    if (character === "[" || character === "(" || character === "{") depth += 1
    else if (character === "]" || character === ")" || character === "}") {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return undefined
}

/** Every `deps: [...]` array, as the offsets of its brackets. */
const depsArrays = (masked: string): ReadonlyArray<{ readonly open: number; readonly close: number }> => {
  const pattern = /(?:^|[^\w$.])deps\s*:\s*\[/g
  const found: Array<{ readonly open: number; readonly close: number }> = []
  for (const match of masked.matchAll(pattern)) {
    const open = match.index + match[0].length - 1
    const close = closes(masked, open)
    if (close !== undefined) found.push({ open, close })
  }
  return found
}

/** Every top-level statement, as a half-open range over the masked text. */
const statements = (masked: string): ReadonlyArray<{ readonly start: number; readonly end: number }> => {
  const starts: Array<number> = []
  let depth = 0
  for (let index = 0; index < masked.length; index += 1) {
    const character = masked[index]!
    const lineStart = index === 0 || masked[index - 1] === "\n"
    if (depth === 0 && lineStart && !/\s/.test(character)) starts.push(index)
    if (character === "[" || character === "(" || character === "{") depth += 1
    else if (character === "]" || character === ")" || character === "}") depth = Math.max(0, depth - 1)
  }
  return starts.map((start, index) => ({ start, end: starts[index + 1] ?? masked.length }))
}

const identifier = "[A-Za-z_$][\\w$]*"

/**
 * The top-level statement that constructs the named target.
 *
 * `export const lib = Smithers.TsBuild({ ... })` is the statement itself.
 * `export const lib = standard.lib` names a binding, and the statement that
 * defines that binding is the one constructing the target, so the search
 * follows it. A destructuring export, `export const { lib, test } = ...`,
 * counts as the declaration of every name it binds.
 */
const targetStatement = (
  masked: string,
  target: string
): { readonly start: number; readonly end: number } | undefined => {
  const ranges = statements(masked)
  const texts = ranges.map((range) => masked.slice(range.start, range.end))
  const boundary = `(?![\\w$])`
  const declares = (name: string): number =>
    texts.findIndex((text) =>
      new RegExp(`^(?:export\\s+)?(?:const|let|var)\\s+${name}${boundary}`).test(text) ||
      new RegExp(`^(?:export\\s+)?(?:const|let|var)\\s+\\{(?:[^}]*[\\s,])?${name}${boundary}[^}]*\\}`).test(text)
    )
  const visited = new Set<string>()
  let name = target.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")
  while (!visited.has(name)) {
    visited.add(name)
    const index = declares(name)
    if (index < 0) return undefined
    const text = texts[index]!
    const alias = new RegExp(
      `^(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*=\\s*(${identifier})(?:\\s*\\.\\s*${identifier})*\\s*;?\\s*$`
    ).exec(text)
    if (alias === null) return ranges[index]
    name = alias[1]!
  }
  return undefined
}

/** The camelCase identifier a package directory suggests. */
const bindingBase = (directory: string): string => {
  const base = directory.slice(directory.lastIndexOf("/") + 1)
  const parts = base.split(/[^A-Za-z0-9]+/).filter((part) => part !== "")
  const head = parts[0] ?? "dep"
  const camel = head + parts.slice(1).map((part) => part[0]!.toUpperCase() + part.slice(1)).join("")
  return /^[A-Za-z_$]/.test(camel) ? camel : `dep${camel}`
}

/** The specifier one file writes to reach another. */
const relativeSpecifier = (from: string, to: string): string => {
  const source = from === "" ? [] : from.split("/")
  const destination = to.split("/")
  let shared = 0
  while (shared < source.length && shared < destination.length - 1 && source[shared] === destination[shared]) {
    shared += 1
  }
  const up = source.length - shared
  const segments = [...Array.from({ length: up }, () => ".."), ...destination.slice(shared)]
  return up === 0 ? `./${segments.join("/")}` : segments.join("/")
}

/**
 * Decides the dependency section of one `BUILD.ts`.
 *
 * A sibling counts as declared when the file imports its `BUILD.ts` and names
 * the resulting binding in some `deps` array. A sibling counts as required
 * when a source file imports its package name. The difference is the drift.
 *
 * The edit goes into the `deps` array of the statement that constructs the
 * library target, found by name: `export const lib = Smithers.TsBuild({ ... })`
 * directly, or `export const lib = standard.lib` through the statement that
 * defines `standard`. The first `deps` array in the file is not a safe anchor:
 * `packages/build/BUILD.ts` writes its first one inside a `PackageDefaults`
 * macro, and an edit there would add the edge to every synthesized package. A
 * file whose library target has no `deps` array has no dependency section, so
 * a missing edge is reported and nothing is edited.
 *
 * @category planning
 * @since 0.1.0
 */
export const plan = (request: Request): Plan => {
  const target = request.target ?? defaultTarget
  const directory = request.path.includes("/") ? request.path.slice(0, request.path.lastIndexOf("/")) : ""
  const masked = mask(request.contents)
  const real = new Set(Imports.scan(request.contents).map((found) => found.specifier))
  const bindings = siblingBindings(request.contents, masked, directory, real)
  const arrays = depsArrays(masked)
  const named = new Set<string>()
  for (const array of arrays) {
    for (const word of masked.slice(array.open, array.close).match(/[A-Za-z_$][\w$]*/g) ?? []) named.add(word)
  }
  const declared = [...new Set(bindings.filter((binding) => named.has(binding.local)).map((entry) => entry.directory))]
    .sort()

  const byName = new Map(request.packages.map((entry) => [entry.name, entry.directory] as const))
  const required = new Map<string, { readonly name: string; readonly evidence: Evidence }>()
  for (const source of [...request.sources].sort((left, right) => left.path.localeCompare(right.path))) {
    for (const found of Imports.scan(source.text)) {
      const bare = Imports.parseBare(found.specifier)
      if (bare === undefined) continue
      const owner = byName.get(bare.name)
      if (owner === undefined || owner === directory || declared.includes(owner) || required.has(owner)) continue
      required.set(owner, {
        name: bare.name,
        evidence: { file: source.path, line: found.line, specifier: found.specifier, typeOnly: found.typeOnly }
      })
    }
  }

  const reserved = new Set(masked.match(/[A-Za-z_$][\w$]*/g) ?? [])
  const missing: Array<Edge> = []
  const additions: Array<{ readonly binding: string; readonly specifier: string }> = []
  for (const owner of [...required.keys()].sort()) {
    const entry = required.get(owner)!
    const existing = bindings.find((binding) => binding.directory === owner && binding.exported === target)
    let binding = existing?.local
    if (binding === undefined) {
      const base = bindingBase(owner)
      binding = base
      for (let suffix = 2; reserved.has(binding); suffix += 1) binding = `${base}${suffix}`
      reserved.add(binding)
      additions.push({ binding, specifier: relativeSpecifier(directory, `${owner}/BUILD.ts`) })
    }
    missing.push({ name: entry.name, directory: owner, binding, evidence: entry.evidence })
  }
  if (missing.length === 0) {
    return { path: request.path, declared, missing, contents: request.contents, blocked: undefined }
  }

  const statement = targetStatement(masked, target)
  const array = statement === undefined
    ? undefined
    : arrays.find((entry) => entry.open >= statement.start && entry.open < statement.end)
  const anchor = importStatements(masked).at(-1)
  if (statement === undefined) {
    return {
      path: request.path,
      declared,
      missing,
      contents: request.contents,
      blocked: `the file declares no \`${target}\` target, so there is no dependency section to edit`
    }
  }
  if (array === undefined) {
    return {
      path: request.path,
      declared,
      missing,
      contents: request.contents,
      blocked: `the \`${target}\` target declares no deps array, so there is no dependency section to edit`
    }
  }
  if (anchor === undefined && additions.length > 0) {
    return {
      path: request.path,
      declared,
      missing,
      contents: request.contents,
      blocked: "the file writes no import statement, so a sibling BUILD.ts import has nowhere to go"
    }
  }

  const inner = request.contents.slice(array.open + 1, array.close)
  const trimmed = inner.trimEnd()
  const joined = missing.map((edge) => edge.binding).join(", ")
  const edits: Array<{ readonly index: number; readonly text: string }> = trimmed === ""
    ? [{ index: array.open + 1, text: joined }]
    : [{
      index: array.open + 1 + trimmed.length,
      text: trimmed.endsWith(",") ? ` ${joined}` : `, ${joined}`
    }]
  if (anchor !== undefined && additions.length > 0) {
    const terminator = request.contents[anchor.end] === ";" ? ";" : ""
    edits.push({
      index: anchor.end + terminator.length,
      text: additions.map((addition) =>
        `\nimport { ${target} as ${addition.binding} } from ${JSON.stringify(addition.specifier)}${terminator}`
      ).join("")
    })
  }
  let contents = request.contents
  for (const edit of [...edits].sort((left, right) => right.index - left.index)) {
    contents = contents.slice(0, edit.index) + edit.text + contents.slice(edit.index)
  }
  return { path: request.path, declared, missing, contents, blocked: undefined }
}

/**
 * Renders the drift one plan found.
 *
 * @category rendering
 * @since 0.1.0
 */
export const describe = (plan: Plan): string => {
  const edges = plan.missing.map((edge) => {
    const kind = edge.evidence.typeOnly ? "type-only import" : "import"
    return `  ${edge.directory} (${edge.name}), from the ${kind} at ` +
      `${edge.evidence.file}:${edge.evidence.line}`
  }).join("\n")
  const blocked = plan.blocked === undefined ? "" : `\n${plan.blocked}`
  return `${plan.path} does not declare ${plan.missing.length} dependency edge` +
    `${plan.missing.length === 1 ? "" : "s"} its sources import:\n${edges}${blocked}`
}

/**
 * Reports drift and mutates nothing.
 *
 * @category effects
 * @since 0.1.0
 */
export const check = (request: Request): Effect.Effect<Plan, GeneratedFile.DriftError> =>
  Effect.suspend(() => {
    const result = plan(request)
    return result.missing.length === 0
      ? Effect.succeed(result)
      : Effect.fail(GeneratedFile.driftError(request.path, describe(result)))
  })

/**
 * Adds every missing edge to the file, through the atomic publication path
 * every other generated file uses.
 *
 * The gate is checked before the plan, so a refused run reads nothing. A file
 * with no missing edge is not written at all: the write half of a mode duality
 * must be a no-op when there is no drift, or every check run would see a fresh
 * mtime.
 *
 * @category effects
 * @since 0.1.0
 */
export const write = (
  options: {
    readonly workspaceRoot: string
    readonly environment: Environment
  },
  request: Request
): Effect.Effect<Plan, RefusedError | PlacementError | GeneratedFile.WriteFileError> =>
  Effect.suspend((): Effect.Effect<Plan, RefusedError | PlacementError | GeneratedFile.WriteFileError> => {
    const reason = refusal(options.environment)
    if (reason !== undefined) return Effect.fail(new RefusedError({ path: request.path, reason }))
    const result = plan(request)
    if (result.missing.length === 0) return Effect.succeed(result)
    if (result.blocked !== undefined) {
      return Effect.fail(new PlacementError({ path: request.path, reason: result.blocked }))
    }
    return Effect.as(
      GeneratedFile.writeGeneratedFile(options.workspaceRoot, { path: result.path, contents: result.contents }),
      result
    )
  })
