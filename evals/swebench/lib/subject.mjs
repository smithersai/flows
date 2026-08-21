/**
 * Fingerprints the subject under test: the exact bytes `flows.sh` will load.
 *
 *   node lib/subject.mjs [--json] [--check] [--expect <file>] [--write <file>]
 *
 * A wave grades a harness. Which harness is a fact about module resolution,
 * not about which commits happen to be in the log, and until this file existed
 * nothing in the rig established it. Two things make it non-obvious:
 *
 *   1. The workspace `exports` map of every `@smthrs/*` package points at
 *      `./src/*.ts`, not at `./dist`. `packages/cli/dist/esm/bin.js` therefore
 *      resolves `@smthrs/harness/CellTurn` to
 *      `packages/harness/src/CellTurn.ts` and Node strips its types on load.
 *      The harness under test is the WORKING TREE, at the instant each CLI
 *      process starts. `packages/harness/dist` is not in the loaded graph at
 *      all, so its mtime proves nothing either way.
 *   2. `packages/cli` is the one package whose compiled output IS loaded, via
 *      the `bin.js` entry point. That dist can be older than its own source.
 *
 * So the fingerprint is: for every package in the CLI's `@smthrs/*` dependency
 * closure, where its entry point resolves to (src or dist), and a content hash
 * of the directory that answer selects — plus a content hash of the CLI's dist.
 * `--check` refuses a subject that cannot be reported honestly.
 *
 * The refusals, and what each one caught:
 *
 *   no-cli-build      `packages/cli/dist/esm/bin.js` is missing.
 *   partial-cli-build a `src/X.ts` has no `dist/esm/X.js`. `--no-bail` and a
 *                     `...` filter closure both produce this silently.
 *   foreign-subject   a package resolves outside this checkout's `packages/`.
 *   unbuilt-dist      a dependency resolves into `dist/`, which this rig does
 *                     not build; its bytes would be whatever was left there.
 *   dirty-subject     a subject package's `src` differs from `git HEAD`, so no
 *                     report may name a commit as the thing it measured. Set
 *                     SWB_ALLOW_DIRTY_SUBJECT=1 to run anyway; the fingerprint
 *                     records the differing paths either way.
 *
 * @since 0.1.0
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join, relative, resolve, sep } from "node:path"

const here = import.meta.dirname
const root = resolve(here, "../../..")
const binary = join(root, "packages/cli/dist/esm/bin.js")

/** Every file under a directory, as repository-relative paths, sorted. */
const filesUnder = (directory) => {
  if (!existsSync(directory)) return []
  const walk = (current) =>
    readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
      const path = join(current, entry.name)
      return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : []
    })
  return walk(directory).map((path) => relative(root, path)).sort()
}

/**
 * A content hash of a set of files: their repository-relative names and their
 * bytes, in sorted order. Names are inside the hash so that adding, removing
 * or renaming a file changes the answer.
 */
const hashFiles = (paths) => {
  const hash = createHash("sha256")
  for (const path of paths) {
    hash.update(path)
    hash.update("\u0000")
    hash.update(readFileSync(join(root, path)))
    hash.update("\u0000")
  }
  return `sha256:${hash.digest("hex")}`
}

const hashFile = (path) => `sha256:${createHash("sha256").update(readFileSync(join(root, path))).digest("hex")}`

const git = (...args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" })
  return result.status === 0 ? result.stdout.trim() : undefined
}

/**
 * The paths under `prefix` whose working-tree content differs from `HEAD`,
 * including files git does not track. Both halves matter: a sibling lane's
 * uncommitted edit and a stray new module are equally able to change what a
 * wave measures.
 */
const differsFromHead = (prefix) => {
  const tracked = git("diff", "--name-only", "HEAD", "--", prefix) ?? ""
  const untracked = git("ls-files", "--others", "--exclude-standard", "--", prefix) ?? ""
  return [...tracked.split("\n"), ...untracked.split("\n")].filter((line) => line.length > 0).sort()
}

/**
 * Walks the `@smthrs/*` dependency closure of `packages/cli`, resolving each
 * package the way the running process will.
 *
 * Resolution is anchored at the importer, not at the entry point: pnpm links
 * `@smthrs/core` into `packages/harness/node_modules`, not into
 * `packages/cli/node_modules`, so asking `bin.js` for it answers "no such
 * module" while the harness loads it fine. Every edge is therefore resolved
 * from the directory of the package that declares the dependency, which is
 * what Node does.
 */
const closure = (refusals) => {
  const byName = new Map()
  for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifest = join(root, "packages", entry.name, "package.json")
    if (!existsSync(manifest)) continue
    const parsed = JSON.parse(readFileSync(manifest, "utf8"))
    byName.set(parsed.name, { directory: `packages/${entry.name}`, manifest: parsed })
  }
  const cli = byName.get("@smthrs/cli")
  // The process enters at the built binary, which is the one compiled artifact
  // in the graph. Everything below it is source, and this walk proves it.
  const found = new Map([["@smthrs/cli", { ...cli, resolved: binary }]])
  const pending = [{ name: "@smthrs/cli", record: cli }]
  while (pending.length > 0) {
    const { name, record } = pending.pop()
    const anchor = createRequire(join(root, record.directory, "package.json"))
    for (const dependency of Object.keys(record.manifest.dependencies ?? {})) {
      if (!dependency.startsWith("@smthrs/") || found.has(dependency)) continue
      const next = byName.get(dependency)
      if (next === undefined) {
        refusals.push({
          code: "foreign-subject",
          message: `${name} depends on ${dependency}, which is not a package in this checkout`
        })
        continue
      }
      let resolved
      try {
        resolved = anchor.resolve(dependency)
      } catch (error) {
        refusals.push({
          code: "unresolvable",
          message: `${name} cannot resolve its dependency ${dependency}: ${error.message.split("\n")[0]}`
        })
        continue
      }
      found.set(dependency, { ...next, resolved })
      pending.push({ name: dependency, record: next })
    }
  }
  return found
}

/**
 * Builds the fingerprint. Never throws on a bad subject: the problems are
 * returned as `refusals` so `--json` can report a subject that `--check`
 * rejects.
 */
export const fingerprint = ({ compareToHead = true } = {}) => {
  const refusals = []
  if (!existsSync(binary)) {
    refusals.push({
      code: "no-cli-build",
      message: `${relative(root, binary)} does not exist; run evals/swebench/preflight.sh`
    })
    return { root, refusals, packages: {}, stamp: undefined }
  }
  const require = createRequire(binary)
  const packages = {}
  for (const [name, record] of [...closure(refusals)].sort(([a], [b]) => a < b ? -1 : 1)) {
    const inside = relative(root, record.resolved)
    if (inside.startsWith("..") || inside.startsWith(sep)) {
      refusals.push({ code: "foreign-subject", message: `${name} resolves outside this checkout, to ${record.resolved}` })
      continue
    }
    const segments = inside.split(sep)
    const kind = segments.includes("dist") ? "dist" : segments.includes("src") ? "src" : "other"
    if (kind === "dist" && name !== "@smthrs/cli") {
      refusals.push({
        code: "unbuilt-dist",
        message:
          `${name} resolves into a build directory (${inside}) that this rig does not build; its bytes are whatever was left there`
      })
    }
    if (kind === "other") {
      refusals.push({ code: "foreign-subject", message: `${name} resolves to ${inside}, which is neither src nor dist` })
    }
    // The CLI is entered through `dist/esm/bin.js`; its `dist/cjs` twin is
    // built and never loaded, so it is not part of the subject.
    const directory = kind === "dist" ? `${record.directory}/dist/esm` : `${record.directory}/src`
    const files = filesUnder(join(root, directory))
    const dirty = compareToHead ? differsFromHead(`${record.directory}/src`) : []
    if (dirty.length > 0) {
      refusals.push({
        code: "dirty-subject",
        message: `${name} does not match git HEAD: ${dirty.length} path(s), first ${dirty[0]}`
      })
    }
    packages[name] = {
      directory: record.directory,
      resolvedEntry: inside,
      loadsFrom: kind,
      hashedDirectory: directory,
      files: files.length,
      hash: hashFiles(files),
      dirty
    }
  }
  // The CLI's own compiled output is the only build artifact in the loaded
  // graph. A `src/X.ts` with no `dist/esm/X.js` is the signature of a build
  // that stopped early, which is exactly what `--no-bail` over a filter
  // closure produces: a dist that exists, imports fine, and is a prefix of the
  // program the report claims to have run.
  const sources = filesUnder(join(root, "packages/cli/src")).filter((path) => path.endsWith(".ts"))
  const emitted = new Set(filesUnder(join(root, "packages/cli/dist/esm")).filter((path) => path.endsWith(".js")))
  const missing = sources
    .map((path) => path.replace("packages/cli/src/", "packages/cli/dist/esm/").replace(/\.ts$/, ".js"))
    .filter((path) => !emitted.has(path))
  if (missing.length > 0) {
    refusals.push({
      code: "partial-cli-build",
      message: `the built CLI is missing ${missing.length} module(s), first ${missing[0]}`
    })
  }
  const cliDist = {
    directory: "packages/cli/dist/esm",
    files: emitted.size,
    hash: hashFiles([...emitted].sort()),
    missing
  }
  // The marker a wave report cites. `CellTurn.ts` is where the read-only cap,
  // the park refusal and the mutation accounting live, so it is the single
  // file that answers "which controls could this wave possibly have run".
  const marker = {
    path: "packages/harness/src/CellTurn.ts",
    hash: hashFile("packages/harness/src/CellTurn.ts"),
    resolvedBy: (() => {
      try {
        return relative(root, require.resolve("@smthrs/harness/CellTurn"))
      } catch {
        return undefined
      }
    })()
  }
  const record = {
    head: compareToHead ? git("rev-parse", "HEAD") : undefined,
    headSubject: compareToHead ? git("log", "-1", "--format=%s") : undefined,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    marker,
    cliDist,
    packages
  }
  const stamp = `sha256:${
    createHash("sha256").update(JSON.stringify({
      marker: record.marker,
      cliDist: { hash: record.cliDist.hash, files: record.cliDist.files },
      packages: Object.fromEntries(
        Object.entries(packages).map(([name, value]) => [name, { hash: value.hash, loadsFrom: value.loadsFrom }])
      )
    })).digest("hex")
  }`
  return { root, refusals, stamp, ...record }
}

const options = process.argv.slice(2)
const optionValue = (name) => {
  const index = options.indexOf(name)
  return index < 0 ? undefined : options[index + 1]
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  // Comparing every package against HEAD costs two `git` processes per
  // package. A wave re-verifies the stamp on every CLI invocation and the
  // stamp does not depend on that comparison, so `--expect` on its own skips
  // it and stays under 200 ms.
  const subject = fingerprint({
    compareToHead: options.includes("--check") || !options.includes("--expect")
  })
  const expected = optionValue("--expect")
  if (expected !== undefined) {
    if (!existsSync(expected)) {
      console.error(`subject.mjs: no recorded fingerprint at ${expected}; run evals/swebench/preflight.sh`)
      process.exit(3)
    }
    const recorded = JSON.parse(readFileSync(expected, "utf8"))
    if (recorded.stamp !== subject.stamp) {
      console.error(
        `subject.mjs: the subject changed since the preflight recorded it.\n`
          + `  recorded ${recorded.stamp}\n  current  ${subject.stamp}\n`
          + `A sibling lane edited a package the CLI loads, or the CLI was rebuilt.\n`
          + `Re-run evals/swebench/preflight.sh and start the wave over: the frames\n`
          + `already run and the frames still to run would not be the same subject.`
      )
      process.exit(4)
    }
  }
  if (options.includes("--check")) {
    const allowDirty = process.env.SWB_ALLOW_DIRTY_SUBJECT === "1"
    const fatal = subject.refusals.filter((refusal) => !(allowDirty && refusal.code === "dirty-subject"))
    if (fatal.length > 0) {
      console.error("subject.mjs: refusing to run a wave on this subject.")
      for (const refusal of fatal) console.error(`  ${refusal.code}: ${refusal.message}`)
      if (fatal.some((refusal) => refusal.code === "dirty-subject")) {
        console.error("  (set SWB_ALLOW_DIRTY_SUBJECT=1 to measure an uncommitted subject anyway)")
      }
      process.exit(2)
    }
    if (subject.refusals.length > 0) {
      console.error("subject.mjs: measuring an uncommitted subject, by SWB_ALLOW_DIRTY_SUBJECT=1:")
      for (const refusal of subject.refusals) console.error(`  ${refusal.code}: ${refusal.message}`)
    }
  }
  const written = optionValue("--write")
  if (written !== undefined) writeFileSync(written, `${JSON.stringify(subject, undefined, 2)}\n`)
  if (options.includes("--json")) console.log(JSON.stringify(subject, undefined, 2))
  else if (!options.includes("--quiet")) {
    console.log(`subject ${subject.stamp}`)
    console.log(`  HEAD          ${subject.head} ${subject.headSubject ?? ""}`)
    console.log(`  node          ${subject.node} ${subject.platform}`)
    console.log(`  CellTurn.ts   ${subject.marker.hash}`)
    console.log(`                loaded from ${subject.marker.resolvedBy}`)
    console.log(`  cli dist      ${subject.cliDist.hash} (${subject.cliDist.files} modules)`)
    for (const [name, value] of Object.entries(subject.packages)) {
      const dirty = value.dirty.length === 0 ? "" : ` DIRTY(${value.dirty.length})`
      console.log(`  ${name.padEnd(24)} ${value.loadsFrom.padEnd(4)} ${value.hash}${dirty}`)
    }
  }
}
