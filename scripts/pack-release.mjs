/**
 * Packs publishable workspace tarballs without changing the Effect-style
 * source exports used by this repository.
 *
 * npm preserves `package.json#exports` when packing; it does not replace it
 * with `publishConfig.exports`. Each package intentionally follows Effect's
 * source-first manifest shape, so release packing happens from a temporary
 * copy whose exports are rewritten to the already-built ESM/CJS artifacts.
 */
import { spawn } from "node:child_process"
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * Dependency order used for release packing and publication.
 */
export const workspaces = [
  "canonical",
  "capability",
  "crypto",
  "database",
  "keys",
  "jj",
  "journal",
  "run-store",
  "step-cache",
  "flow",
  "engine",
  "kernel",
  "platform-browser",
  "platform-node",
  "platform-bun",
  "plugin",
  "sandbox",
  "sync",
  "engine-store",
  "time-travel",
  "flows"
]

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Produces the manifest that belongs in a registry tarball.
 */
export const publicationManifest = (manifest) => {
  if (!isRecord(manifest)) {
    throw new TypeError("package manifest must be an object")
  }
  const publishConfig = manifest.publishConfig
  if (!isRecord(publishConfig) || !isRecord(publishConfig.exports)) {
    throw new TypeError(`${String(manifest.name ?? "package")} must declare publishConfig.exports`)
  }
  const { exports, ...publishedConfig } = publishConfig
  return {
    ...manifest,
    exports,
    publishConfig: publishedConfig
  }
}

const sourceFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory()
      ? sourceFiles(path)
      : entry.name.endsWith(".ts") ? [path] : []
  }))
  return nested.flat()
}

const assertBuilt = async (packageRoot) => {
  const sourceRoot = join(packageRoot, "src")
  for (const source of await sourceFiles(sourceRoot)) {
    const modulePath = relative(sourceRoot, source).slice(0, -3)
    await Promise.all([
      access(join(packageRoot, "dist", "esm", `${modulePath}.js`)),
      access(join(packageRoot, "dist", "esm", `${modulePath}.d.ts`)),
      access(join(packageRoot, "dist", "cjs", `${modulePath}.js`))
    ])
  }
}

const copyFilter = (packageRoot) => (source) => {
  const path = relative(packageRoot, source)
  if (path === "") return true
  const segments = path.split(sep)
  return !segments.some((segment) =>
    segment === "node_modules" ||
    segment === "coverage" ||
    segment === ".smithers"
  ) && !basename(path).endsWith(".tsbuildinfo")
}

const run = (command, args, options = {}) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "inherit"],
      ...options
    })
    let stdout = ""
    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk) => {
      stdout += chunk
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun(stdout)
      } else {
        reject(new Error(`${command} exited with ${code ?? signal ?? "unknown status"}`))
      }
    })
  })

const packWorkspace = async (name, outputDirectory, stagingRoot) => {
  const packageRoot = join(repoRoot, "packages", name)
  await assertBuilt(packageRoot)

  const manifestPath = join(packageRoot, "package.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  const stagedPackage = join(stagingRoot, name)
  await cp(packageRoot, stagedPackage, {
    recursive: true,
    filter: copyFilter(packageRoot)
  })
  await writeFile(
    join(stagedPackage, "package.json"),
    `${JSON.stringify(publicationManifest(manifest), null, 2)}\n`
  )

  const output = await run(
    "npm",
    ["pack", stagedPackage, "--json", "--ignore-scripts", "--pack-destination", outputDirectory]
  )
  const result = JSON.parse(output)
  const filename = result[0]?.filename
  if (typeof filename !== "string") {
    throw new Error(`npm pack returned no filename for ${String(manifest.name)}`)
  }
  return {
    name: manifest.name,
    version: manifest.version,
    filename
  }
}

export const main = async (args) => {
  const destination = args[0]
  if (destination === undefined) {
    throw new Error("usage: node scripts/pack-release.mjs <output-directory>")
  }
  const outputDirectory = resolve(repoRoot, destination)
  await mkdir(outputDirectory, { recursive: true })
  const stagingRoot = await mkdtemp(join(tmpdir(), "smthrs-release-pack-"))
  try {
    const packed = []
    for (const name of workspaces) {
      packed.push(await packWorkspace(name, outputDirectory, stagingRoot))
    }
    await writeFile(
      join(outputDirectory, "manifest.json"),
      `${JSON.stringify(packed, null, 2)}\n`
    )
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}

const isMain = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isMain) {
  await main(process.argv.slice(2))
}
