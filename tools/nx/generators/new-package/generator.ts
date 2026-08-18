/**
 * New-package generator: the Nx equivalent of the `NewPackage` rule in
 * packages/targets. Like that rule, it writes the smallest tree the workspace
 * defaults pick up — and deliberately NO project.json, because a standard
 * package needs none: the plugins in nx.json synthesize its check, test,
 * lint, fmt, and build targets from the same conventional files every other
 * package carries.
 *
 * The manifest shape (script set, exports, publishConfig, pinned dev
 * dependencies) is read from an existing sibling at generation time so the
 * scaffold cannot drift from the fleet's pinned toolchain versions.
 */
import { generateFiles, joinPathFragments, readJsonFile, type Tree } from "@nx/devkit"
import { join } from "node:path"

interface NewPackageSchema {
  readonly name: string
  readonly group: "engine" | "agent" | "tooling"
  readonly description?: string
}

/** The package whose manifest defines the current conventional shape. */
const SHAPE_SOURCE = "packages/crypto/package.json"

export default async function newPackage(tree: Tree, schema: NewPackageSchema) {
  const shortName = schema.name.trim()
  if (!/^[a-z][a-z0-9-]*$/.test(shortName)) {
    throw new Error(`Invalid package name "${schema.name}": expected lowercase kebab-case, for example "run-store".`)
  }
  const projectRoot = joinPathFragments("packages", shortName)
  if (tree.exists(`${projectRoot}/package.json`)) {
    throw new Error(`packages/${shortName} already exists.`)
  }

  const sibling = readJsonFile<Record<string, unknown>>(join(tree.root, SHAPE_SOURCE))
  const name = `@smthrs/${shortName}`
  const description = schema.description ?? "TODO: describe this package."

  const manifest = {
    name,
    type: sibling["type"],
    version: sibling["version"],
    license: sibling["license"],
    smthrs: { group: schema.group },
    description,
    homepage: sibling["homepage"],
    repository: { ...(sibling["repository"] as Record<string, unknown>), directory: projectRoot },
    bugs: sibling["bugs"],
    keywords: sibling["keywords"],
    engines: sibling["engines"],
    sideEffects: sibling["sideEffects"],
    exports: sibling["exports"],
    files: sibling["files"],
    publishConfig: sibling["publishConfig"],
    scripts: sibling["scripts"],
    dependencies: sibling["dependencies"],
    devDependencies: sibling["devDependencies"]
  }
  tree.write(`${projectRoot}/package.json`, `${JSON.stringify(manifest, null, 2)}\n`)

  generateFiles(tree, join(import.meta.dirname, "files"), projectRoot, {
    name,
    shortName,
    group: schema.group,
    description
  })
}
