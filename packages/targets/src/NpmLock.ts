/**
 * Per-package npm addressing: `npm("effect")` as a declared input.
 *
 * D12 makes every npm package a target key input. Three deliberate safety
 * properties forbid the obvious implementation, and this module relaxes none
 * of them: declared-input expansion never walks `node_modules`
 * (`Input.ts` skips the directory name and refuses patterns rooted in it),
 * declared-output capture refuses symbolic links, and no output may live under
 * the reserved `.flows` root. A pnpm `node_modules` tree is a symlink farm
 * into the store, so a file-set answer would have to break all three.
 *
 * The handle is therefore derived from the lockfile, not from the installed
 * tree. `npm(name)` resolves the package's lockfile entries — name, version,
 * and resolution integrity — and the transitive dependency closure the
 * lockfile records for them, and returns an {@link Input.NpmPackage}
 * declaration carrying a digest of exactly that material. A target keyed on
 * the declaration re-keys when the package's entry or closure changes and
 * stays stable when an unrelated entry changes, which is what the single
 * coarse `ambient.lockfile` digest cannot express. The installed tree is
 * never read.
 *
 * The lockfile is read and parsed lazily on the first `npm(name)` call of a
 * handle, memoized from then on. The parse runs during BUILD.ts evaluation,
 * the same evaluation every other declaration constructor runs in, and the
 * file it reads is the same file the planner already digests for ambient key
 * material; `PnpmLock.parseSync` exists for exactly this caller. Constructing
 * the handle itself performs no I/O.
 *
 * Only pnpm is supported. `PnpmLock` reads the pnpm 9 lockfile format, and
 * the other managers have no parsed lockfile at all, so a workspace that
 * registers another manager is refused when a package is first addressed.
 *
 * @since 0.1.0
 */
import * as PnpmLock from "@smthrs/build/PnpmLock"
import * as Effect from "effect/Effect"
import * as NodeFs from "node:fs"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"
import { getCallSites } from "node:util"
import * as Input from "./Input.ts"
import * as PackageManager from "./PackageManager.ts"

/**
 * Options accepted by {@link NpmLock}.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /**
   * The lockfile the accessor resolves packages from. A `//` prefix anchors
   * the path at the directory of the declaring `WORKSPACE.ts`; an absolute
   * path is used as given, which is how tests point a handle at a fixture.
   *
   * @default the registered package manager's lockfile, at the workspace root
   */
  readonly lockfile?: Input.File | undefined
}

/**
 * The accessor a workspace exports from `WORKSPACE.ts`: `npm("effect")`
 * declares the package as a content-addressed input.
 *
 * @category models
 * @since 0.1.0
 */
export interface NpmLock {
  (name: string): Input.NpmPackage
}

/** The declaration file frames a lockfile path or a refusal is reported against. */
const declarationFileNames: ReadonlyArray<string> = ["WORKSPACE.ts", "BUILD.ts"]

interface Site {
  readonly path: string
  readonly line: number | undefined
}

/**
 * The nearest `WORKSPACE.ts` or `BUILD.ts` frame above the caller, or
 * undefined when the host exposes no call sites. Mirrors `Target.sourceSite`:
 * a refusal names the declaration line the author has to edit, never a frame
 * inside this package.
 */
const declarationSite = (): Site | undefined => {
  let sites: ReturnType<typeof getCallSites>
  try {
    sites = getCallSites(100, { sourceMap: true })
  } catch {
    return undefined
  }
  for (const site of sites) {
    let file = site.scriptName
    try {
      if (file.startsWith("file:")) file = fileURLToPath(file)
    } catch {
      continue
    }
    if (!declarationFileNames.includes(NodePath.basename(file))) continue
    const line = typeof site.lineNumber === "number" && Number.isSafeInteger(site.lineNumber) &&
        site.lineNumber > 0
      ? site.lineNumber
      : undefined
    return { path: NodePath.resolve(file), line }
  }
  return undefined
}

const formatSite = (site: Site | undefined): string =>
  site === undefined
    ? "an unknown declaration site"
    : site.line === undefined
    ? site.path
    : `${site.path}:${site.line}`

const controlCharacter = /[\u0000-\u001f\u007f]/

const usableName = (name: string, site: Site | undefined): string => {
  if (
    typeof name !== "string" ||
    name.trim() === "" ||
    name.length > 256 ||
    !name.isWellFormed() ||
    controlCharacter.test(name)
  ) {
    throw new Error(`npm(${JSON.stringify(String(name))}) is not a package name, declared at ${formatSite(site)}`)
  }
  return name
}

/** One handle's resolved lockfile: the absolute path and the parsed content. */
interface Resolved {
  readonly path: string
  readonly lockfile: PnpmLock.Lockfile
}

/**
 * Creates the workspace's npm package accessor.
 *
 * The constructor is inert: it records the declaration and the call site and
 * reads nothing. The first `npm(name)` call reads and parses the lockfile
 * once per handle and every later call reuses the parse.
 *
 * An unknown package name is refused at the `npm(name)` call, with the
 * declaration line named in the message, because a silent empty digest would
 * key a target on nothing.
 *
 * @example
 * ```ts
 * // WORKSPACE.ts
 * export const npm = Smithers.NpmLock({ lockfile: Smithers.file("//pnpm-lock.yaml") })
 * ```
 *
 * ```ts
 * // packages/flow/BUILD.ts
 * const npm = Smithers.NpmLock({ lockfile: Smithers.file("//pnpm-lock.yaml") })
 *
 * export const lib = Smithers.TsBuild({ srcs: [sources, npm("effect")], ... })
 * ```
 *
 * A BUILD.ts evaluates in a module instance separate from the one the engine
 * uses for `WORKSPACE.ts`, so it constructs the accessor (or imports it from
 * a plain module) instead of importing `WORKSPACE.ts`: importing a
 * declaration file from a BUILD.ts evaluates that file a second time, and
 * `registerToolchains` refuses the repeated registration. Construction is
 * inert, so a per-package accessor costs nothing until a name is addressed.
 * The lockfile path anchors at the nearest `WORKSPACE.ts` or `BUILD.ts`
 * frame above the constructor call; a workspace-rooted anchor therefore
 * belongs in a root-level module.
 *
 * @category constructors
 * @since 0.1.0
 */
export const NpmLock = (options: Options = {}): NpmLock => {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("NpmLock requires an options object, for example NpmLock({ lockfile: Smithers.file(\"//pnpm-lock.yaml\") })")
  }
  const lockfile = options.lockfile
  if (lockfile !== undefined && !Input.isDeclared(lockfile)) {
    throw new TypeError("NpmLock requires the lockfile as a declared file, for example Smithers.file(\"//pnpm-lock.yaml\")")
  }
  if (lockfile !== undefined && lockfile._tag !== "File") {
    throw new TypeError("NpmLock requires the lockfile as a file declaration, not a glob or a diff")
  }
  const home = declarationSite()
  let resolved: Resolved | undefined
  const resolve = (): Resolved => {
    if (resolved !== undefined) return resolved
    const manager = PackageManager.registeredToolchain().packageManager
    if (manager.name !== "pnpm") {
      throw new Error(
        `NpmLock declared at ${formatSite(home)} requires pnpm: the lockfile parser reads the pnpm 9 ` +
          `format, and ${manager.name} writes no lockfile it can read`
      )
    }
    const declared = lockfile ?? Input.file(`//${PackageManager.lockfileName(manager)}`)
    const text = declared.path
    // The `//` anchor is checked before absoluteness: POSIX treats a leading
    // `//` as absolute, which would read the lockfile from the filesystem
    // root instead of the workspace root.
    const path = text.startsWith("//") || !NodePath.isAbsolute(text)
      ? (() => {
        if (home === undefined) {
          throw new Error(
            `NpmLock cannot resolve ${JSON.stringify(text)}: the declaration site is unknown, ` +
              "so no workspace root can be inferred; declare the lockfile with an absolute path"
          )
        }
        return NodePath.join(NodePath.dirname(home.path), text.startsWith("//") ? text.slice(2) : text)
      })()
      : text
    const stat = (() => {
      try {
        return NodeFs.statSync(path)
      } catch (cause) {
        throw new PnpmLock.PnpmLockError({
          code: "lockfile_unreadable",
          message: `NpmLock declared at ${formatSite(home)} could not read ${path}`,
          cause
        })
      }
    })()
    if (!stat.isFile()) {
      throw new PnpmLock.PnpmLockError({
        code: "lockfile_unreadable",
        message: `NpmLock declared at ${formatSite(home)}: ${path} is not a regular file`
      })
    }
    if (stat.size > PnpmLock.maximumSourceBytes) {
      throw new PnpmLock.PnpmLockError({
        code: "lockfile_too_large",
        message: `${path} is larger than ${PnpmLock.maximumSourceBytes} bytes`
      })
    }
    const source = NodeFs.readFileSync(path, "utf8")
    resolved = { path, lockfile: PnpmLock.parseSync(source) }
    return resolved
  }
  return (name: string): Input.NpmPackage => {
    const site = declarationSite()
    const parsed = resolve()
    const entries = PnpmLock.packagesNamed(parsed.lockfile, usableName(name, site))
    if (entries.length === 0) {
      throw new Error(
        `npm(${JSON.stringify(name)}) names no package in ${parsed.path}, declared at ${formatSite(site)}`
      )
    }
    const closures: Array<string> = []
    for (const snapshot of PnpmLock.snapshotsNamed(parsed.lockfile, name)) {
      const text = Effect.runSyncExit(PnpmLock.closureText(parsed.lockfile, snapshot.id))
      if (text._tag === "Failure") {
        throw new Error(
          `npm(${JSON.stringify(name)}) has an incomplete lockfile closure, declared at ${formatSite(site)}`,
          { cause: text.cause }
        )
      }
      closures.push(text.value)
    }
    return Input.NpmPackage.make({
      name,
      versions: entries.map((entry) => entry.key),
      closure: Input.digestText(closures.join("\n"))
    })
  }
}

/**
 * The key-material digest of one npm package declaration.
 *
 * Expansion is pure: the declaration already carries the closure digest
 * resolved when it was built, so the planner hashes the carried identity and
 * reads nothing.
 *
 * @category digests
 * @since 0.1.0
 */
export const npmPackageDigest = (declaration: Input.NpmPackage): string =>
  Input.digestText(JSON.stringify(declaration))
